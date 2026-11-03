#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""demo_data.py —— 演示数据统一入口：init | clean | reset | status | check

  python3 scripts/demo_data.py status                    # 服务端上本系统数据概况
  python3 scripts/demo_data.py check                     # 只看 CapabilityStatement 支持性
  python3 scripts/demo_data.py init [-- --only Task]     # 初始化导入
  python3 scripts/demo_data.py clean [-- --dry-run]      # 清理
  python3 scripts/demo_data.py reset                     # 清理 + 重新导入（演示前一键复位）
"""
from __future__ import annotations
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import demo_common as C  # noqa: E402
import init_demo_data  # noqa: E402
import clean_demo_data  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def status(base, scope):
    base = C.normalize_base(base)
    C.log("服务端：%s" % base)
    caps = C.load_capabilities(base)
    report = C.check_capabilities(base, caps)
    if report["missing"]:
        C.warn("以下类型服务端不提供，演示数据也不会包含：%s" % "、".join(report["missing"]))
    total = 0
    C.log("\n本系统（demo-scope=%s）在各类型的条数：" % scope)
    seen = set()
    tally = C.REQUIRED_TYPES + ["Observation", "DetectedIssue", "MedicationAdministration", "Basic"]
    for t in tally:
        if t in seen:
            continue
        seen.add(t)
        try:
            lst = C.search_all(base, t, {"_tag": "%s|%s" % (C.SCOPE_SYSTEM, scope), "_elements": "id"}, page=100)
        except C.FhirError as e:
            C.log("  %-24s 读取失败：%s" % (t, e)); continue
        if lst:
            total += len(lst)
            C.log("  %-24s %5d 条" % (t, len(lst)))
    C.log("\n合计 %d 条" % total)
    # 锚点资源：前端判断「服务端是否已初始化」用的必然存在项
    for anchor in ("Basic/Basic-catalog-version", "Organization/Organization-hospital-demo"):
        try:
            t, rid = anchor.split("/")
            C.http_json("GET", "%s/%s/%s" % (base, t, rid), timeout=20)
            C.log("锚点 %s 存在 ✓" % anchor)
        except C.FhirError:
            C.warn("锚点 %s 不存在 —— 演示数据尚未初始化" % anchor)
    return 0


def main():
    ap = argparse.ArgumentParser(description="抗菌药物分级管理演示数据管理")
    ap.add_argument("command", choices=["init", "clean", "reset", "status", "check"])
    ap.add_argument("--base", default=os.environ.get("FHIR_BASE") or C.DEFAULT_BASE)
    ap.add_argument("--scope", default=os.environ.get("DEMO_SCOPE") or C.DEFAULT_SCOPE)
    ap.add_argument("--yes", action="store_true")
    ap.add_argument("--bundle")
    ap.add_argument("--with-usage-records", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("rest", nargs="*", help="-- 之后的参数透传给子命令")
    args = ap.parse_args()
    common = ["--base", args.base, "--scope", args.scope]
    if args.yes:
        common.append("--yes")
    if args.bundle:
        common += ["--bundle", args.bundle]
    extra = args.rest[:]
    if args.with_usage_records and "init" in (args.command,):
        extra.append("--with-usage-records")

    if args.command == "init":
        return init_demo_data.main(common + extra)
    if args.command == "clean":
        return clean_demo_data.main(common + extra)
    if args.command == "reset":
        C.log("=== 第 1/2 步：清理旧演示数据 ===")
        rc = clean_demo_data.main(["--base", args.base, "--scope", args.scope, "--yes"])
        if rc:
            C.warn("清理阶段有失败，继续尝试重新导入")
        C.log("\n=== 第 2/2 步：重新导入演示数据 ===")
        return init_demo_data.main(["--base", args.base, "--scope", args.scope, "--yes"] + extra)
    if args.command == "check":
        C.check_capabilities(C.normalize_base(args.base))
        return 0
    return status(args.base, args.scope)


if __name__ == "__main__":
    sys.exit(main())
