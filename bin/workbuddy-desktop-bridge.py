"""加载已安装的 Desktop Bridge，并兼容桌面空闲时尚无 ACP Host 的情况。"""
from pathlib import Path
import argparse
import atexit
import importlib
import json
import site
import sys


def install_idle_discovery(acp):
    original = acp.discover_desktop_server
    original_rpc = acp._rpc
    runtimes = set()

    def rpc(pipe, method, params=None):
        if method == "session.create" and params:
            params = {**params, "env": dict(params.get("env") or {})}
            # 新版 sidecar 只在动态端口模式交付加密凭据上下文；固定端口会导致 missing-key。
            params["port"] = 0
            args = params.get("args") or []
            if args:
                dist = Path(args[0]).parent.parent / "dist"
                if (dist / "codebuddy-lite-wb.mjs").is_file() and not (dist / "codebuddy-headless.js").is_file():
                    params["env"].setdefault("CODEBUDDY_FORCE_LITE_WB_BUNDLE", "1")
        result = original_rpc(pipe, method, params)
        if params and str(params.get("sessionId", "")).startswith("codex-worker-"):
            key = (pipe, params["sessionId"])
            if method == "session.create":
                runtimes.add(key)
            elif method == "session.kill":
                runtimes.discard(key)
        return result

    def cleanup():
        for pipe, session_id in list(runtimes):
            try:
                original_rpc(pipe, "session.kill", {"sessionId": session_id})
            except Exception:
                pass

    acp._rpc = rpc
    atexit.register(cleanup)

    def discover():
        try:
            return original()
        except acp.WorkBuddyError as exc:
            # 只补齐没有预先创建 Host 的空闲态；认证拒绝等错误保留原始行为。
            if "desktop ACP host not found" not in str(exc):
                raise
            for _, pipe, pid in acp._candidate_sidecars():
                try:
                    acp._rpc(pipe, "session.list")
                    executable = acp._process_executable(pid)
                    cli = executable.parent / "resources" / "app.asar.unpacked" / "cli" / "bin" / "codebuddy"
                    if cli.is_file():
                        return acp.DesktopServer("", "", "", pipe, pid, pid)
                except Exception:
                    continue
            raise

    acp.discover_desktop_server = discover


def install_prompt_errors(acp, server):
    # 某些版本在拒绝 prompt 时不发 prompt_start，旧桥接器会丢失真实鉴权错误。
    original_prompt = acp.AcpClient.prompt

    def prompt(client, *args, **kwargs):
        response = original_prompt(client, *args, **kwargs)
        result = response.get("result") or {}
        error = (result.get("_meta") or {}).get("codebuddy.ai/errorMessage")
        if error:
            try:
                parsed = json.loads(error)
                error = (parsed.get("data") or {}).get("details") or parsed.get("message") or error
            except (ValueError, TypeError):
                pass
            client._workbench_prompt_error = str(error)
            raise acp.WorkBuddyError(str(error))
        return response

    acp.AcpClient.prompt = prompt
    original_dispatch = server._dispatch_prompt

    def dispatch(task, client, *args, **kwargs):
        try:
            return original_dispatch(task, client, *args, **kwargs)
        except acp.WorkBuddyError:
            error = getattr(client, "_workbench_prompt_error", "")
            if error:
                raise acp.WorkBuddyError(error) from None
            raise

    server._dispatch_prompt = dispatch


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--bridge-root", required=True)
    options = parser.parse_args()
    root = Path(options.bridge_root).resolve()
    if not (root / "workbuddy_bridge" / "server.py").is_file():
        raise RuntimeError("Configured WorkBuddy Desktop Bridge installation is missing")
    site.addsitedir(str(root / "vendor"))
    sys.path.insert(0, str(root))
    from workbuddy_bridge import acp
    install_idle_discovery(acp)
    server = importlib.import_module("workbuddy_bridge.server")
    install_prompt_errors(acp, server)
    server.mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
