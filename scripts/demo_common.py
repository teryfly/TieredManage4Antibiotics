#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""demo_common.py —— 演示数据脚本的公共部分（只用标准库，免 pip 安装）

约定：
  * 数据来源是 build/seed-bundle.json，由 scripts/export_seed.js 从 js/seed.js
    导出（单一数据源：前端装载用的种子与脚本灌库用的是同一份定义）。
  * 每条写入服务端的资源都带 meta.tag[https://fhir.amr-demo.example/demo-scope]，
    清理只按这个标签删，绝不做类型级全量清空 —— hapi.fhir.org 是无鉴权的共享
    演示服务器，别人也在里面放数据。
"""
from __future__ import annotations
import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_BASE = "https://hapi.fhir.org/baseR4"
DEFAULT_SCOPE = "kjywfj-demo-v2"
SCOPE_SYSTEM = "https://fhir.amr-demo.example/demo-scope"
R4_ID_SYSTEM = "https://fhir.amr-demo.example/id"
BUNDLE_NAME = os.path.join("build", "seed-bundle.json")
PUBLIC_HOSTS = ("hapi.fhir.org", "hapi202402.singaporecloud.hl7.org", "test.hl7.org", "r4.simpler-health.com")

# SRS §10.2 要求启动/灌库前检查的资源类型
REQUIRED_TYPES = [
    "Patient", "Encounter", "Practitioner", "PractitionerRole", "Organization",
    "Medication", "MedicationKnowledge", "MedicationRequest", "PlanDefinition",
    "Task", "Communication", "CommunicationRequest", "Provenance", "AuditEvent",
    "Bundle", "Basic", "StructureDefinition", "CodeSystem", "ValueSet",
]


class FhirError(RuntimeError):
    def __init__(self, message, status=None, outcome=None):
        super().__init__(message)
        self.status = status
        self.outcome = outcome


def log(msg: str) -> None:
    print(msg, flush=True)


def warn(msg: str) -> None:
    log("  ⚠️  " + msg)


def fail(msg: str) -> None:
    log("  ✗ " + msg)


def http_json(method, url, body=None, headers=None, timeout=30, retries=2):
    """带重试的 JSON 请求。公共演示服务器偶发 5xx/限流，重试两轮再报错。"""
    data = None
    hdr = {"Accept": "application/fhir+json", "Content-Type": "application/fhir+json"}
    if headers:
        hdr.update(headers)
    if body is not None:
        data = body.encode("utf-8") if isinstance(body, str) else json.dumps(body).encode("utf-8")
    ctx = ssl.create_default_context()
    last = None
    for attempt in range(retries + 1):
        req = urllib.request.Request(url, data=data, method=method, headers=hdr)
        try:
            with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
                raw = resp.read().decode("utf-8", "replace")
                return json.loads(raw) if raw.strip() else {}
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8", "replace")
            try:
                outcome = json.loads(raw)
            except Exception:
                outcome = None
            issues = (outcome or {}).get("issue") or []
            parts = []
            for i in issues:
                t = (i.get("details", {}) or {}).get("text") or i.get("diagnostics") or i.get("code") or ""
                expr = ", ".join(i.get("expression") or [])
                parts.append(("%s%s" % (t, (" @ " + expr) if expr else "")).strip())
            text = "; ".join(p for p in parts if p) or ("HTTP %s" % e.code)
            last = FhirError("%s (HTTP %s)" % (text.replace("&quot;", '"'), e.code), e.code, outcome)
            if e.code in (429, 500, 502, 503, 504) and attempt < retries:
                time.sleep(1.5 * (attempt + 1))
                continue
            raise last
        except (urllib.error.URLError, TimeoutError) as e:
            last = FhirError("网络不可达：%s（%s）" % (url, e))
            if attempt < retries:
                time.sleep(1.5 * (attempt + 1))
                continue
            raise last
    raise last


def normalize_base(base: str) -> str:
    base = (base or "").strip().rstrip("/")
    if not base.lower().startswith(("http://", "https://")):
        raise FhirError("服务端地址必须以 http:// 或 https:// 开头，收到：%r" % base)
    return base


def is_public(base: str) -> bool:
    host = urllib.parse.urlparse(base).netloc.lower()
    return any(h in host for h in PUBLIC_HOSTS)


def search_all(base: str, path, params, page=100):
    """按 searchset 翻页取全量（返回 entry.resource 列表）。"""
    out = []
    url = "%s/%s?%s" % (base, path, urllib.parse.urlencode({**params, "_count": page}))
    while url:
        bundle = http_json("GET", url, timeout=40)
        for e in bundle.get("entry") or []:
            if e.get("resource"):
                out.append(e["resource"])
        url = None
        for link in bundle.get("link") or []:
            if link.get("relation") == "next":
                url = link.get("url")
                break
    return out


def load_capabilities(base: str):
    md = http_json("GET", base + "/metadata", timeout=40)
    rest = (md.get("rest") or [{}])[0]
    types = {}
    for r in rest.get("resource") or []:
        types[r.get("type")] = {i.get("code") for i in (r.get("interaction") or [])}
    return {
        "fhirVersion": md.get("fhirVersion", ""),
        "software": (md.get("software") or {}).get("name", ""),
        "system": {i.get("code") for i in (rest.get("interaction") or [])},
        "types": types,
    }


def check_capabilities(base: str, caps=None, quiet=False) -> dict:
    """SRS §10.2：逐类型检查 read/search/create/update/delete/vread 支持性。
    不支持就显式列出来，不得假装写入成功。"""
    caps = caps or load_capabilities(base)
    report = {"fhirVersion": caps["fhirVersion"], "software": caps["software"],
              "transaction": "transaction" in caps["system"], "missing": [], "partial": []}
    for t in REQUIRED_TYPES:
        inter = caps["types"].get(t)
        if inter is None:
            report["missing"].append(t)
            continue
        need = {"create", "read", "search-type", "update"}
        gap = sorted(need - inter)
        if gap:
            report["partial"].append("%s 缺 %s" % (t, "/".join(gap)))
    if not quiet:
        log("服务端：FHIR %s · %s" % (caps["fhirVersion"], caps["software"] or "未知实现"))
        log("事务 Bundle：%s" % ("支持" if report["transaction"] else "不支持（改用逐条 PUT）"))
        if report["missing"]:
            warn("服务端不支持的类型：%s" % "、".join(report["missing"]))
        if report["partial"]:
            warn("交互不完整：%s" % "；".join(report["partial"]))
        if not report["missing"] and not report["partial"]:
            log("所需 %d 种资源类型均可读写 ✓" % len(REQUIRED_TYPES))
    return report


def load_bundle(root: str, path_hint=None, rebuild=True, extra_flags=()):
    """读取种子包；默认每次都重新生成 —— 种子只定义在 js/seed.js 里，
    用陈旧的 bundle 灌库会让服务端数据与代码不一致（演示时最难查的问题）。"""
    target = path_hint or os.path.join(root, BUNDLE_NAME)
    if rebuild or not os.path.exists(target):
        run_exporter(root, target, extra_flags)
    if not os.path.exists(target):
        raise FhirError("找不到种子包 %s；请先运行 node scripts/export_seed.js" % target)
    with open(target, encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data.get("resources"), dict) or not data.get("meta"):
        raise FhirError("种子包格式不对，应由 scripts/export_seed.js 生成")
    return data, target


def run_exporter(root, out_path, extra_flags=()):
    node = "node"
    script = os.path.join(root, "scripts", "export_seed.js")
    cmd = [node, script, "--out", out_path, *(list(extra_flags))]
    log("▶ 正在从 js/seed.js 生成种子包（单一数据源）…")
    t0 = time.time()
    rc = os.system(" ".join('"%s"' % c if " " in c else c for c in cmd))
    if rc != 0:
        raise FhirError("export_seed.js 执行失败（退出码 %s）。请确认 node 可用。" % rc)
    log("  生成完成（%.1fs）" % (time.time() - t0))


def confirm(prompt: str, assume_yes: bool) -> bool:
    if assume_yes:
        return True
    try:
        ans = input(prompt + " [y/N] ").strip().lower()
    except EOFError:
        return False
    return ans in ("y", "yes")
