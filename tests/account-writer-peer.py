"""Offline test fixture: one native Python process sharing the Node writer's database."""
import json
import os
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server" / "execution"))
from account_writer import AccountWriter, AccountWriterError, account_key

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")

config = json.loads(sys.argv[1])
if config.get("recoveryGate"):
    original_unlink = os.unlink
    recovery_waited = False

    def gated_unlink(target, **kwargs):
        global recovery_waited
        prefix = config["databasePath"] + ".required.tmp-"
        if not recovery_waited and str(target).startswith(prefix) and not str(target).startswith(prefix + str(os.getpid()) + "-"):
            recovery_waited = True
            gate = Path(config["recoveryGate"])
            Path(str(gate) + ".ready").write_text("ready", encoding="utf-8")
            deadline = time.monotonic() + 5
            while not gate.exists():
                if time.monotonic() >= deadline:
                    raise TimeoutError("marker recovery gate timed out")
                time.sleep(0.01)
        return original_unlink(target, **kwargs)

    os.unlink = gated_unlink
if config.get("markerGate") or config.get("exitAfterMarkerLink"):
    original_link = os.link

    def gated_link(source, destination, **kwargs):
        if str(destination) == config["databasePath"] + ".required":
            if config.get("exitAfterMarkerLink"):
                original_link(source, destination, **kwargs)
                os._exit(73)
            gate = Path(config["markerGate"])
            Path(str(gate) + ".ready").write_text("ready", encoding="utf-8")
            deadline = time.monotonic() + 5
            while not gate.exists():
                if time.monotonic() >= deadline:
                    raise TimeoutError("marker publication gate timed out")
                time.sleep(0.01)
        return original_link(source, destination, **kwargs)

    os.link = gated_link
writer = AccountWriter(config["databasePath"], config["moduleId"], config["runtimeId"])
print(json.dumps({"ready": True}), flush=True)
try:
    for line in sys.stdin:
        request = json.loads(line)
        try:
            if request["method"] == "account_key":
                result = account_key(*request.get("args", []))
            else:
                result = getattr(writer, request["method"])(*request.get("args", []))
            print(json.dumps({"id": request["id"], "result": result}, ensure_ascii=False), flush=True)
            if request["method"] == "close":
                break
        except AccountWriterError as error:
            print(json.dumps({"id": request["id"], "code": error.code}), flush=True)
finally:
    writer.close()
