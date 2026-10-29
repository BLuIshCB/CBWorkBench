import json
from pathlib import Path
import runpy
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

shim = runpy.run_path(str(Path(__file__).resolve().parents[1] / "bin" / "workbuddy-desktop-bridge.py"))


class WorkBuddyError(RuntimeError):
    pass


class BridgeCompatibilityTests(unittest.TestCase):
    def fake_acp(self, root, error="desktop ACP host not found"):
        return SimpleNamespace(
            WorkBuddyError=WorkBuddyError,
            discover_desktop_server=Mock(side_effect=WorkBuddyError(error)),
            _candidate_sidecars=lambda: [(None, "test-pipe", 42)],
            _rpc=Mock(return_value=[]), _process_executable=lambda pid: root / "WorkBuddy.exe",
            DesktopServer=lambda *args: args,
        )

    def test_idle_sidecar_and_lite_bundle(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cli_root = root / "resources" / "app.asar.unpacked" / "cli"
            (cli_root / "bin").mkdir(parents=True)
            (cli_root / "bin" / "codebuddy").touch()
            (cli_root / "dist").mkdir()
            (cli_root / "dist" / "codebuddy-lite-wb.mjs").touch()
            acp = self.fake_acp(root)
            original_rpc = acp._rpc
            shim["install_idle_discovery"](acp)
            self.assertEqual(acp.discover_desktop_server()[-1], 42)
            original_params = {"sessionId": "codex-worker-test", "port": 54321, "args": [str(cli_root / "bin" / "codebuddy")], "env": {}}
            acp._rpc("test-pipe", "session.create", original_params)
            params = original_rpc.call_args.args[2]
            self.assertEqual(params["env"]["CODEBUDDY_FORCE_LITE_WB_BUNDLE"], "1")
            self.assertEqual(params["port"], 0, "Native credential bootstrap is only activated with port=0")
            self.assertEqual(original_params["port"], 54321, "Keep the caller's request unchanged")
            self.assertEqual(original_params["env"], {}, "Do not mutate the caller's environment")
            acp._rpc("test-pipe", "session.kill", {"sessionId": "codex-worker-test"})

    def test_auth_rejection_is_never_bypassed(self):
        acp = self.fake_acp(Path("unused"), "Discovered WorkBuddy password was rejected")
        original_rpc = acp._rpc
        shim["install_idle_discovery"](acp)
        with self.assertRaisesRegex(WorkBuddyError, "password was rejected"):
            acp.discover_desktop_server()
        original_rpc.assert_not_called()

    def test_prompt_refusal_keeps_auth_cause(self):
        class Client:
            def prompt(self, *args, **kwargs):
                return {"result": {"stopReason": "refusal", "_meta": {
                    "codebuddy.ai/errorMessage": json.dumps({"message": "Authentication required", "data": {"category": "auth"}}),
                }}}

        acp = SimpleNamespace(AcpClient=Client, WorkBuddyError=WorkBuddyError)
        server = SimpleNamespace(_dispatch_prompt=Mock(side_effect=WorkBuddyError("did not accept prompt")))
        shim["install_prompt_errors"](acp, server)
        client = Client()
        with self.assertRaisesRegex(WorkBuddyError, "Authentication required"):
            client.prompt("test")
        with self.assertRaisesRegex(WorkBuddyError, "Authentication required"):
            server._dispatch_prompt(None, client)


if __name__ == "__main__":
    unittest.main()
