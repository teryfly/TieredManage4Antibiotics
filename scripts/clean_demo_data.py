#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""clean_demo_data.py —— 清理演示数据脚本写入 FHIR 服务端的资源

安全边界（重要）：
  * 只删除带 meta.tag[https://fhir.amr-demo.example/demo-scope=<scope>] 的资源；
    为解除引用保护而额外删除的资源，必须先用 meta.tag[…/id=<id>] 确认是本系统写的。
  * 必须显式给出 --scope；不提供就退出。绝不做「某类型全量清空」——
    hapi.fhir.org 是无鉴权的共享演示服务器，别人的测试数据也在里面。
  * 服务端开启了引用完整性保护，删除被引用的资源会返回 409，因此按轮次迭代：
    每一轮删掉能删的，把阻塞方加入下一轮，最多 5 轮。
  * 目标是公共服务器时二次确认（--yes 跳过）。

用法：
  python3 scripts/clean_demo_data.py --scope kjywfj-demo-v2 --dry-run
  python3 scripts/clean_demo_data.py --scope kjywfj-demo-v2 --yes
  python3 scripts/clean_demo_data.py --base http://localhost:8081/fhir --scope kjywfj-demo-v2
"""
from __future__ import annotations
import argparse
import os
import re
import sys
import time
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import demo_common as C  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# 删除顺序 = 写入顺序的逆序（先删引用方，再删被引用方）
DELETE_ORDER = [
    "MedicationAdministration", "Endpoint", "AuditEvent", "Provenance", "Communication",
    "CommunicationRequest", "Task", "Observation", "DetectedIssue", "MedicationRequest",
    "PlanDefinition", "Basic", "Encounter", "PractitionerRole", "MedicationKnowledge",
    "Medication", "Practitioner", "Patient", "Organization", "ValueSet", "CodeSystem",
    "StructureDefinition",
]
RANK = {t: i for i, t in enumerate(DELETE_ORDER)}
BLOCK_RE = re.compile(r"First reference found was resource ([A-Za-z]+)/([^\s;]+)")
MAX_ROUNDS = 5


def scoped_types(base, scope, root=None):
    """两条路取待删清单：
       1) 按 _tag=demo-scope 检索（服务端索引可能有秒级滞后）；
       2) 按种子包里的 id 逐个 GET —— 本系统全部用语义化 id 写入，
          GET 不依赖搜索索引，能补上检索漏掉的那部分，避免公共服务器上留残数据。"""
    found = {}
    for t in DELETE_ORDER:
        try:
            lst = C.search_all(base, t, {"_tag": "%s|%s" % (C.SCOPE_SYSTEM, scope), "_elements": "id"}, page=100)
        except C.FhirError as e:
            C.warn("%s 检索失败：%s" % (t, e))
            lst = []
        ids = {r.get("id") for r in lst if r.get("id")}
        for rid in bundle_ids(root, t):
            if rid in ids:
                continue
            try:
                r = C.http_json("GET", "%s/%s/%s" % (base, t, rid), timeout=20)
            except C.FhirError:
                continue                       # 404/410 表示确实不存在
            tags = ((r.get("meta") or {}).get("tag") or [])
            mine = any(c.get("system") == C.SCOPE_SYSTEM for c in tags)
            cur = [c.get("code") for c in tags if c.get("system") == C.SCOPE_SYSTEM]
            if mine and (scope in cur or args_allow_other_scope()):
                ids.add(rid)
        if ids:
            found[t] = sorted(ids)
    return found


OTHER_SCOPE = [None]
def args_allow_other_scope():
    return False
def bundle_ids(root, t):
    if not root:
        return []
    import json, os
    path = os.path.join(root, C.BUNDLE_NAME)
    if not os.path.exists(path):
        return []
    cache = getattr(bundle_ids, "_cache", None)
    if cache is None:
        try:
            with open(path, encoding="utf-8") as f:
                cache = json.load(f).get("resources") or {}
        except Exception:
            cache = {}
        bundle_ids._cache = cache
    return [r.get("id") for r in cache.get(t, []) if r.get("id")]


def is_ours(base, rtype, rid):
    """用本系统写入的语义 id 标签确认资源归属；确认不了就绝不删除。"""
    try:
        lst = C.search_all(base, rtype, {"_tag": "%s|%s" % (C.R4_ID_SYSTEM, rid), "_elements": "id"}, page=5)
    except C.FhirError:
        return False
    return any(r.get("id") == rid for r in lst)


def main(argv=None):
    ap = argparse.ArgumentParser(description="清理抗菌药物分级管理演示数据")
    ap.add_argument("--base", default=os.environ.get("FHIR_BASE") or C.DEFAULT_BASE,
                    help="FHIR 服务基地址（默认 %(default)s）")
    ap.add_argument("--scope", default=os.environ.get("DEMO_SCOPE"),
                    help="要清理的演示作用域（必填；对应 meta.tag 的 code）")
    ap.add_argument("--only", action="append", default=[], help="只清理这些类型，可重复")
    ap.add_argument("--dry-run", action="store_true", help="只列出将要删除的资源，不删除")
    ap.add_argument("--yes", action="store_true", help="跳过二次确认")
    args = ap.parse_args(argv)

    if not args.scope:
        C.fail("必须显式指定 --scope（或设置环境变量 DEMO_SCOPE）。")
        C.fail("本脚本不做无作用域的全量清空：公共演示服务器上的数据是共享的，")
        C.fail("按 demo-scope 标签删除才能保证只删掉本系统自己写入的资源。")
        return 2
    if args.scope.strip() in ("*", "all", "any"):
        C.fail("--scope 不能是通配值，必须是一个具体的作用域标识")
        return 2

    base = C.normalize_base(args.base)
    C.log("目标服务端：%s" % base)
    C.log("清理作用域：%s = %s" % (C.SCOPE_SYSTEM, args.scope))
    if C.is_public(base):
        C.warn("这是无鉴权的公共演示服务器，删除不可恢复；只删除带上述标签的资源。")
        if not args.dry_run and not C.confirm("确认执行删除？", args.yes):
            C.log("已取消。")
            return 1

    # _tag 检索在服务端索引滞后时会返回空，id 逐个 GET 是兜底；种子包不在就先生成，
    # 否则兜底路径没有 id 清单可用，清理会"成功地"删掉 0 条。
    try:
        C.load_bundle(ROOT, rebuild=False)
    except C.FhirError as e:
        C.warn("拿不到种子包，仅按 _tag 检索清理：%s" % e)

    found = scoped_types(base, args.scope, ROOT)
    if args.only:
        want = set(args.only)
        found = {k: v for k, v in found.items() if k in want}
    targets = {(t, rid) for t, ids in found.items() for rid in ids}
    if not targets:
        C.log("\n没有找到该作用域的数据，无需清理。")
        return 0

    C.log("\n将按逆引用顺序删除 %d 条：" % len(targets))
    for t in DELETE_ORDER:
        if t in found:
            C.log("  %-24s %5d 条" % (t, len(found[t])))
    if args.dry_run:
        C.log("\n[dry-run] 未删除任何资源。去掉 --dry-run 即执行。")
        return 0

    deleted = set()
    errors = []
    t0 = time.time()
    rounds = 0
    while rounds < MAX_ROUNDS:
        rounds += 1
        pending = sorted(targets - deleted, key=lambda x: RANK.get(x[0], 99))
        if not pending:
            break
        before = len(deleted)
        for t, rid in pending:
            try:
                C.http_json("DELETE", "%s/%s/%s" % (base, t, urllib.parse.quote(rid, safe="")), timeout=40)
                deleted.add((t, rid))
            except C.FhirError as e:
                if e.status in (404, 410):
                    deleted.add((t, rid))       # 已不存在，视为清理完成
                    continue
                m = BLOCK_RE.search(str(e))
                if e.status == 409 and m:
                    bt, bid = m.group(1), m.group(2)
                    if (bt, bid) not in targets and is_ours(base, bt, bid):
                        targets.add((bt, bid))  # 本系统写的引用方，下一轮先删它
                    continue
                errors.append("%s/%s：%s" % (t, rid, e))
        grew = len(targets) - len(pending) - len(deleted)
        C.log("  第 %d 轮：删除 %d 条；待删 %d 条%s" % (
            rounds, len(deleted) - before, len(targets - deleted),
            "（发现 %d 个阻塞引用方，均属本系统，已加入队列）" % max(0, grew) if grew > 0 else ""))
        if len(deleted) == before and grew <= 0:
            break

    leftovers = sorted(targets - deleted, key=lambda x: RANK.get(x[0], 99))
    C.log("\n合计删除 %d 条，用时 %.1fs（%d 轮）" % (len(deleted), time.time() - t0, rounds))
    if leftovers:
        C.warn("仍有 %d 条未能删除（被非本系统资源引用，或 HAPI 搜索索引尚未建立）：" % len(leftovers))
        for t, rid in leftovers[:10]:
            C.log("   · %s/%s" % (t, rid))
        C.warn("稍后可重跑本脚本再试一次；本脚本不会删除无法确认归属的资源。")
    if errors:
        C.fail("%d 条删除失败：" % len(errors))
        for e in errors[:15]:
            C.log("   · " + e)
        return 1
    if not leftovers:
        C.log("清理完成。重新初始化：python3 scripts/init_demo_data.py --base %s --scope %s" % (base, args.scope))
    return 0


if __name__ == "__main__":
    sys.exit(main())
