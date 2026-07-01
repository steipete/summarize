---
title: "Chrome enterprise: disable the local companion"
kicker: "apps"
summary: "Keep Direct and Browser modes available while browser policy blocks the optional native companion."
read_when:
  - "When deploying the Chrome extension in a managed company."
  - "When local companion communication must be disabled by policy."
---

# Disable the local companion in managed Chrome

The Chrome Web Store extension ID is `cejgnmmhbbpdmjnfppjdfkocebngehfg`. The registered native
messaging host is `com.steipete.summarize`, and its manifest allows only this exact origin:

```json
{
  "allowed_origins": ["chrome-extension://cejgnmmhbbpdmjnfppjdfkocebngehfg/"]
}
```

The extension declares `nativeMessaging` in `optional_permissions`, not `permissions`. A personal
install therefore starts without local-companion capability. Chrome asks for the named permission
only after the user selects a Daemon runtime or clicks **Enable local companion**. Direct AI and
Browser media modes do not request it.

Chrome's current permissions documentation says most named permissions may be optional and lists
the exceptions; `nativeMessaging` is not an exception. The generated production manifest is also
tested to keep it optional.

## Exact managed policy

Use Chrome's browser-enforced permission block as the primary per-extension boundary. Add the host
block and user-level-host restriction as independent defense in depth, then set the extension's
managed UX policy so users see why Daemon controls are unavailable.

Example Linux managed policy at `/etc/opt/chrome/policies/managed/summarize.json`:

```json
{
  "ExtensionSettings": {
    "cejgnmmhbbpdmjnfppjdfkocebngehfg": {
      "installation_mode": "allowed",
      "blocked_permissions": ["nativeMessaging"],
      "runtime_blocked_hosts": ["http://localhost", "http://127.0.0.1", "http://[::1]"]
    }
  },
  "NativeMessagingBlocklist": ["com.steipete.summarize"],
  "NativeMessagingUserLevelHosts": false,
  "3rdparty": {
    "extensions": {
      "cejgnmmhbbpdmjnfppjdfkocebngehfg": {
        "daemonAllowed": false
      }
    }
  }
}
```

`blocked_permissions` is the decisive per-extension browser control: Chrome prevents this extension
from acquiring or retaining `nativeMessaging`. `NativeMessagingBlocklist` prevents Chrome from
launching the named host even for another extension. `NativeMessagingUserLevelHosts=false` allows
only administrator-installed system hosts; it is not a complete block on its own.

`runtime_blocked_hosts` is an independent browser-enforced guard against local HTTP. The production
manifest retains `http://localhost/*` and `http://127.0.0.1/*` for configured Direct local providers;
daemon requests never use those grants. The exact-ID policy above blocks this extension from
interacting with localhost, IPv4 loopback, or IPv6 loopback on any port. Cloud Direct providers and
Browser mode on ordinary sites continue to work. Chrome policy host patterns omit the path; adding
`/*` here is not valid for this policy.

To disable every native messaging host, use `"NativeMessagingBlocklist": ["*"]`. If the company
needs selected hosts, combine the wildcard block with `NativeMessagingAllowlist` entries. To
force-install Summarize, change `installation_mode` to `force_installed` and add:

```json
{ "update_url": "https://clients2.google.com/service/update2/crx" }
```

The per-ID `ExtensionSettings` entry is intentional. When a specific extension entry exists, only
`installation_mode` and `update_url` inherit from the `"*"` defaults; repeat
`blocked_permissions` on this exact ID.

On Windows, configure the equivalent values under:

- `HKLM\Software\Policies\Google\Chrome\ExtensionSettings` with the JSON dictionary above.
- `HKLM\Software\Policies\Google\Chrome\NativeMessagingBlocklist\1` as the string
  `com.steipete.summarize` (or `*`).
- `HKLM\Software\Policies\Google\Chrome\NativeMessagingUserLevelHosts` as DWORD `0`.
- `HKLM\Software\Policies\Google\Chrome\3rdparty\extensions\cejgnmmhbbpdmjnfppjdfkocebngehfg\policy`
  with `daemonAllowed` as DWORD `0`.

On macOS, deploy the three Chrome policies in the `com.google.Chrome` managed-preferences domain
and set `daemonAllowed=false` in
`com.google.Chrome.extensions.cejgnmmhbbpdmjnfppjdfkocebngehfg`.

In Google Admin, configure the same per-ID `ExtensionSettings` and native-messaging policies, then
set this extension's policy JSON to:

```json
{ "daemonAllowed": false }
```

Verify at `chrome://policy`, restart the extension if policy was applied during an active request,
and confirm:

- Runtime settings show **Disabled by administrator**.
- Direct remains selected for AI and Browser remains selected for media.
- Daemon controls are disabled and no permission prompt appears.
- Chrome rejects `nativeMessaging` for extension ID `cejgnmmhbbpdmjnfppjdfkocebngehfg`.
- Chrome refuses to launch `com.steipete.summarize` when its host block applies.
- Chrome blocks the extension from local HTTP origins when `runtime_blocked_hosts` applies.

`daemonAllowed=false` is UX and fail-closed application behavior, not a substitute for the Chrome
policies. The service worker checks managed policy and current permission again immediately before
every native-host connection.

## Transport and remaining limitation

The service worker sends daemon requests as bounded framed messages to the exact native host. The
bridge accepts only `GET`, `POST`, and `DELETE` requests for `/health` and `/v1/*`, requires the
configured daemon port to match, filters request headers, and chunks responses below Chrome's 1 MiB
native-message limit. The separate retained loopback host grants preserve configured Direct local
providers; daemon routing never selects them by URL.

The companion daemon itself still exposes its bearer-token-authenticated HTTP API on loopback, and
the native process proxies to that API. Native Messaging removes the extension's direct network
capability; it does not give the daemon operating-system peer identity. Another local process—or a
different extension independently granted loopback access—that obtains the token can still call
the daemon. Moving the daemon API entirely onto an OS-authenticated local socket would be a separate
hardening project.

Chrome match patterns cannot express “all HTTP hosts except loopback.” The Store manifest removes
`<all_urls>` while retaining only HTTPS plus localhost and IPv4 loopback for existing Direct local
provider compatibility. Privileged background fetches of a different plain-HTTP host or media asset
are no longer guaranteed. Enterprise deployments that prohibit local providers should keep the
browser-enforced `runtime_blocked_hosts` policy above.

The npm-installed Windows CLI currently lacks the standalone `.exe` launcher that Chrome requires
for a native host path. macOS and Linux install the host end to end; Windows daemon mode is blocked
until release packaging includes that executable shim. Do not work around this with a `.cmd` host
or by routing daemon requests through the Direct-provider loopback grants.

Chrome references:

- [Optional permissions](https://developer.chrome.com/docs/extensions/reference/api/permissions)
- [Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
- [ExtensionSettings policy](https://chromeenterprise.google/policies/extension-settings/)
- [NativeMessagingBlocklist](https://chromeenterprise.google/policies/native-messaging-blocklist/)
- [NativeMessagingUserLevelHosts](https://chromeenterprise.google/policies/native-messaging-user-level-hosts/)
- [Managed storage schema](https://developer.chrome.com/docs/extensions/reference/manifest/storage)
