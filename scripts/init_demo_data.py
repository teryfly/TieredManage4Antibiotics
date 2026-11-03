#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""init_demo_data.py —— 把演示数据初始化导入 FHIR R4 服务端

数据来自 build/seed-bundle.json（由 scripts/export_seed.js 从 js/seed.js 导出，
与前端装载时用的是同一份定义）。写入顺序按引用依赖排列：被引用的类型先落库，
否则服务端的引用完整性校验会整单拒收（HAPI-1094）。

用法：
  python3 scripts/init_demo_data.py                        # 默认公共 baseR4
  python3 scripts/init_demo_data.py --base http://localhost:8081/fhir
  python3 scripts/init_demo_data.py --dry-run              # 只报告要写什么
  python3 scripts/init_demo_data.py --only Task --only Encounter
  python3 scripts/init_demo_data.py --with-usage-records   # 连 4870 条用药记录一起灌（慢）
"""
from __future__ import annotations
import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import demo_common as C  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def build_transaction(entries):
    return {"resourceType": "Bundle", "type": "transaction",
            "entry": [{"resource": e["resource"],
                       "request": {"method": e["method"], "url": e["url"]}} for e in entries]}


def put_one(base, res):
    url = "%s/%s/%s" % (base, res["resourceType"], res["id"])
    return C.http_json("PUT", url, body=res, timeout=40)


def write_type(base, rtype, resources, batch, use_transaction, stats, errors):
    entries = [{"method": "PUT", "url": "%s/%s" % (rtype, r["id"]), "resource": r} for r in resources]
    chunks = [entries[i:i + batch] for i in range(0, len(entries), batch)] if use_transaction else [[e] for e in entries]
    for chunk in chunks:
        if use_transaction and len(chunk) > 1:
            try:
                C.http_json("POST", base, body=build_transaction(chunk), timeout=60)
                stats[rtype] = stats.get(rtype, 0) + len(chunk)
                continue
            except C.FhirError as e:
                C.warn("%s 事务包失败（%s），改为逐条写入" % (rtype, e))
        ok = 0
        for e in chunk:
            try:
                put_one(base, e["resource"])
                ok += 1
            except C.FhirError as err:
                errors.append("%s/%s：%s" % (rtype, e["resource"]["id"], err))
        stats[rtype] = stats.get(rtype, 0) + ok


def main(argv=None):
    ap = argparse.ArgumentParser(description="初始化导入抗菌药物分级管理演示数据")
    ap.add_argument("--base", default=os.environ.get("FHIR_BASE") or C.DEFAULT_BASE,
                    help="FHIR 服务基地址（默认 %(default)s；也可用环境变量 FHIR_BASE）")
    ap.add_argument("--scope", default=C.DEFAULT_SCOPE,
                    help="演示数据作用域，写入每条资源的 meta.tag（默认 %(default)s）")
    ap.add_argument("--bundle", help="种子包路径（默认 build/seed-bundle.json）")
    ap.add_argument("--only", action="append", default=[], help="只写这些类型，可重复")
    ap.add_argument("--batch", type=int, default=25, help="事务 Bundle 每条大小（默认 25）")
    ap.add_argument("--no-transaction", action="store_true", help="不使用事务 Bundle，逐条 PUT")
    ap.add_argument("--with-usage-records", action="store_true",
                    help="连 MedicationAdministration 用药记录一并写入（量大、公共服务器可能限流）")
    ap.add_argument("--keep-bundle", action="store_true", help="沿用已有的 build/seed-bundle.json，不重新生成")
    ap.add_argument("--dry-run", action="store_true", help="只做检查与统计，不写入")
    ap.add_argument("--yes", action="store_true", help="对公共服务器提示不再二次确认")
    args = ap.parse_args(argv)

    if not args.scope or not C.SCOPE_SYSTEM:
        C.fail("必须提供 --scope，清理脚本据此只删除本系统写入的数据"); return 2
    base = C.normalize_base(args.base)

    if C.is_public(base) and not args.dry_run:
        C.warn("目标是无鉴权的公共演示服务器 %s：" % base)
        C.warn("  · 数据公开可读，请勿存放真实患者数据；")
        C.warn("  · 其他人可能同时读写或定期清库；")
        C.warn("  · 本次只写入带 meta.tag[%s=%s] 的资源。" % (C.SCOPE_SYSTEM, args.scope))
        if not C.confirm("确认继续？", args.yes):
            C.log("已取消。"); return 1

    data, bundle_path = C.load_bundle(
        ROOT, args.bundle, rebuild=not args.keep_bundle,
        extra_flags=("--with-usage-records",) if args.with_usage_records else ())
    meta = data["meta"]
    if args.scope != meta.get("demoScope"):
        C.warn("种子包的作用域是 %s，本次要求 %s：将按本次 --scope 重写 meta.tag" % (meta.get("demoScope"), args.scope))

    res_by_type = data["resources"]
    if not args.with_usage_records:
        res_by_type = {k: v for k, v in res_by_type.items() if k != "MedicationAdministration"}
    order = [t for t in meta.get("writeOrder", list(res_by_type.keys())) if t in res_by_type]
    if args.only:
        want = set(args.only)
        order = [t for t in order if t in want]
        unknown = want - set(order)
        if unknown:
            C.warn("种子包中没有这些类型，已忽略：%s" % "、".join(sorted(unknown)))

    total = sum(len(res_by_type[t]) for t in order)
    C.log("种子包：%s（%d 条资源，%d 个类型）" % (os.path.relpath(bundle_path, ROOT), total, len(order)))
    C.log("目标服务端：%s" % base)
    caps = C.load_capabilities(base)
    report = C.check_capabilities(base, caps)
    if report["missing"]:
        for t in report["missing"]:
            if t in order:
                C.warn("服务端不支持 %s，跳过该类型 %d 条" % (t, len(res_by_type[t])))
                total -= len(res_by_type.pop(t, []))
                order.remove(t)
    use_tx = report["transaction"] and not args.no_transaction
    if args.dry_run:
        C.log("\n[dry-run] 将按以下顺序写入 %d 条：" % total)
        for t in order:
            C.log("  %-24s %5d 条  例：%s" % (t, len(res_by_type[t]), ", ".join(r["id"] for r in res_by_type[t][:2])))
        C.log("[dry-run] 未写入任何数据。")
        return 0

    # 重新打标签：保证与本次 --scope 一致（清理脚本据此检索）
    for t in order:
        for r in res_by_type[t]:
            r.setdefault("meta", {})
            r["meta"]["tag"] = [c for c in (r["meta"].get("tag") or []) if c.get("system") != C.SCOPE_SYSTEM]
            r["meta"]["tag"].append({"system": C.SCOPE_SYSTEM, "code": args.scope,
                                     "display": "演示数据作用域 " + args.scope})

    # 作用域冲突提醒：本系统资源用语义化 id（Patient-1 等），同一台服务端上换 scope
    # 再灌一次会把已有资源的 demo-scope 标签改写，旧 scope 的清理就找不到它们了。
    try:
        existing = C.search_all(base, "Basic", {"_tag": "%s|%s" % (C.R4_ID_SYSTEM, "Basic-catalog-version")}, page=5)
        if existing:
            cur = [c.get("code") for r in existing for c in (r.get("meta", {}) or {}).get("tag", [])
                   if c.get("system") == C.SCOPE_SYSTEM]
            if cur and cur != [args.scope]:
                C.warn("服务端已存在本系统数据（现标签 scope=%s）。本系统用固定语义化 id，"
                       "换 scope 重灌会改写这些资源的标签，旧 scope 的清理将失效。" % "/".join(cur))
                C.warn("要么沿用同一 scope，要么先执行：python3 scripts/clean_demo_data.py --scope %s" % cur[0])
    except C.FhirError:
        pass

    stats, errors = {}, []
    t0 = time.time()
    C.log("\n开始写入（事务 Bundle：%s，每包 %d 条）…" % ("启用" if use_tx else "关闭", args.batch))
    for t in order:
        before = len(errors)
        write_type(base, t, res_by_type[t], args.batch, use_tx, stats, errors)
        bad = len(errors) - before
        C.log("  %-24s %5d 条 %s" % (t, stats.get(t, 0), "✓" if not bad else "（%d 条失败）" % bad))
    dur = time.time() - t0

    written = sum(stats.values())
    C.log("\n合计写入 %d/%d 条，用时 %.1fs" % (written, total, dur))
    if errors:
        C.fail("%d 条写入失败：" % len(errors))
        for e in errors[:15]:
            C.log("   · " + e)
        if len(errors) > 15:
            C.log("   · …（另有 %d 条）" % (len(errors) - 15))
        C.warn("失败通常是服务端引用校验或码表差异，请把上面的 HAPI 错误码反馈给开发者")
        return 1
    C.log("\n下一步：浏览器打开 npm start 的页面（默认 http://localhost:8137），"
          "服务端已有数据时前端会直接读取，不再自动灌库。")
    C.log("清理数据：python3 scripts/clean_demo_data.py --base %s --scope %s" % (base, args.scope))
    return 0


if __name__ == "__main__":
    sys.exit(main())
