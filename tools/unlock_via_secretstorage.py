#!/usr/bin/env python3
"""Unlock the login collection via the Secret Service D-Bus API,
completing the prompt with a password (same flow VSCode uses).

Usage: unlock_via_secretstorage.py <password>
Exit 0 when the collection is unlocked.
"""

import sys

import secretstorage
from jeepney import MatchRule, MessageType, new_method_call
from secretstorage.defines import SS_PATH, SS_PREFIX
from secretstorage.util import DBusAddressWrapper


def run_prompt_and_complete(bus, prompt_path, password):
    """Call Prompt(), then Complete(password), then await Completed signal."""
    prompt = DBusAddressWrapper(prompt_path, SS_PREFIX + "Prompt", bus)
    rule = MatchRule(
        path=prompt_path,
        interface=SS_PREFIX + "Prompt",
        member="Completed",
        type=MessageType.signal,
    )
    with bus.filter(rule) as signals:
        # 1) trigger the prompt (daemon tries empty-password unlock)
        bus.send_and_get_reply(new_method_call(prompt, "Prompt", "s", ("",)))
        # 2) complete with the password
        bus.send_and_get_reply(
            new_method_call(prompt, "Complete", "v", (("s", password),))
        )
        # 3) await Completed signal
        return bus.recv_until_filtered(signals).body


def main():
    if len(sys.argv) != 2:
        print("usage: unlock_via_secretstorage.py <password>", file=sys.stderr)
        return 2
    password = sys.argv[1]

    bus = secretstorage.dbus_init()
    if not secretstorage.check_service_availability(bus):
        print("Secret Service not available", file=sys.stderr)
        return 1
    coll = secretstorage.get_default_collection(bus)
    print("collection:", coll)
    print("locked before:", coll.is_locked())

    service = DBusAddressWrapper(SS_PATH, SS_PREFIX + "Service", bus)
    unlocked_paths, prompt = service.call("Unlock", "ao", [coll.collection_path])
    print("prompt:", repr(prompt))
    if len(prompt) > 1:
        dismissed, result = run_prompt_and_complete(bus, prompt, password)
        print("prompt dismissed:", dismissed, "result:", result)
    else:
        print("no prompt needed (already unlocked?)")

    print("locked after:", coll.is_locked())
    return 0 if not coll.is_locked() else 1


if __name__ == "__main__":
    sys.exit(main())
