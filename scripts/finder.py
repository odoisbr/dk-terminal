#!/usr/bin/env python3
"""Prepara e instala a ação local do Finder sem alterar associações padrão."""
import argparse
from pathlib import Path
import plistlib
import shlex
import shutil
import subprocess
import sys
import tempfile
import uuid

ROOT = Path(__file__).resolve().parents[1]
IDENTIFIER = "br.com.sea.dk.open"
SERVICE = "Abrir com DK.workflow"


def workflow(target, command):
    contents = target / "Contents"
    contents.mkdir(parents=True, exist_ok=True)
    metadata = {
        "applicationBundleID": "com.apple.finder",
        "applicationBundleIDsByPath": {"/System/Library/CoreServices/Finder.app": "com.apple.finder"},
        "applicationPath": "/System/Library/CoreServices/Finder.app",
        "applicationPaths": ["/System/Library/CoreServices/Finder.app"],
        "inputTypeIdentifier": "com.apple.Automator.fileSystemObject",
        "outputTypeIdentifier": "com.apple.Automator.nothing",
        "presentationMode": 15, "processesInput": False,
        "serviceApplicationBundleID": "com.apple.finder",
        "serviceApplicationPath": "/System/Library/CoreServices/Finder.app",
        "serviceInputTypeIdentifier": "com.apple.Automator.fileSystemObject",
        "serviceOutputTypeIdentifier": "com.apple.Automator.nothing",
        "serviceProcessesInput": False, "systemImageName": "NSActionTemplate",
        "useAutomaticInputType": False, "workflowTypeIdentifier": "com.apple.Automator.servicesMenu",
    }
    action = {
        "AMAccepts": {"Container": "List", "Optional": True, "Types": ["com.apple.cocoa.string"]},
        "AMActionVersion": "2.0.3", "AMApplication": ["Automator"],
        "AMParameterProperties": {key: {} for key in ["COMMAND_STRING", "CheckedForUserDefaultShell", "inputMethod", "shell", "source"]},
        "AMProvides": {"Container": "List", "Types": ["com.apple.cocoa.string"]},
        "ActionBundlePath": "/System/Library/Automator/Run Shell Script.action",
        "ActionName": "Run Shell Script",
        "ActionParameters": {"COMMAND_STRING": command, "CheckedForUserDefaultShell": True, "inputMethod": 1, "shell": "/bin/zsh", "source": ""},
        "BundleIdentifier": "com.apple.RunShellScript", "CFBundleVersion": "2.0.3",
        "CanShowSelectedItemsWhenRun": False, "CanShowWhenRun": False,
        "Category": ["AMCategoryUtilities"], "Class Name": "RunShellScriptAction",
        "InputUUID": str(uuid.uuid4()), "OutputUUID": str(uuid.uuid4()), "UUID": str(uuid.uuid4()),
        "UnlocalizedApplications": ["Automator"], "arguments": {}, "isViewVisible": True,
    }
    document = {"AMApplicationBuild": "523", "AMApplicationVersion": "2.10", "AMDocumentVersion": "2", "actions": [{"action": action, "isViewVisible": True}], "connectors": {}, "workflowMetaData": metadata}
    info = {
        "CFBundleIdentifier": IDENTIFIER, "CFBundleName": "Abrir com SEA Dock", "DKManagedIntegration": True,
        "NSServices": [{"NSBackgroundColorName": "background", "NSIconName": "NSActionTemplate",
                        "NSMenuItem": {"default": "Abrir com SEA Dock"}, "NSMessage": "runWorkflowAsService",
                        "NSRequiredContext": {"NSApplicationIdentifier": "com.apple.finder"},
                        "NSSendFileTypes": ["public.folder", "public.data"]}],
    }
    for name, value in [("document.wflow", document), ("Info.plist", info)]:
        (contents / name).write_bytes(plistlib.dumps(value, sort_keys=False))
    return target


def validate():
    with tempfile.TemporaryDirectory(prefix="dk-finder-") as temporary:
        base = Path(temporary)
        selected = base / "Projeto O'Connor $; pasta"
        selected.mkdir()
        target = workflow(base / SERVICE, "printf '%s\\n' \"$@\"")
        result = subprocess.run(["/usr/bin/automator", "-i", str(selected), str(target)], capture_output=True, text=True, timeout=30)
        if result.returncode or str(selected) not in result.stdout:
            raise RuntimeError("O Automator não validou a ação: " + (result.stderr or result.stdout)[-2000:])
        print("Automator validado: seleção com espaços e caracteres especiais preservada.")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["prepare", "install", "validate"])
    parser.add_argument("--app", type=Path)
    args = parser.parse_args()
    if sys.platform != "darwin":
        raise SystemExit("A integração com o Finder é exclusiva do macOS.")
    if args.mode == "validate":
        validate()
        return
    if not args.app:
        parser.error("--app é obrigatório")
    bundle = args.app.resolve()
    info = plistlib.loads((bundle / "Contents/Info.plist").read_bytes())
    if info.get("CFBundleIdentifier") != "br.com.sea.dk.terminal":
        raise SystemExit("O aplicativo indicado não é o SEA Dock.")
    command = "exec /usr/bin/open -a " + shlex.quote(str(bundle)) + ' -- "$@"'
    prepared = workflow(ROOT / "integrations/macos" / SERVICE, command)
    if args.mode == "prepare":
        print(prepared)
        return
    destination = Path.home() / "Library/Services" / SERVICE
    if destination.exists():
        previous = plistlib.loads((destination / "Contents/Info.plist").read_bytes())
        if previous.get("CFBundleIdentifier") != IDENTIFIER or not previous.get("DKManagedIntegration"):
            raise SystemExit("Já existe outra ação com esse nome. Ela foi preservada; a nova ação ficou preparada no projeto.")
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(prepared, destination, dirs_exist_ok=True)
    registrar = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
    subprocess.run([registrar, "-f", str(bundle)], check=True, capture_output=True)
    subprocess.run(["/System/Library/CoreServices/pbs", "-update"], check=True, capture_output=True)
    print(destination)


if __name__ == "__main__":
    main()
