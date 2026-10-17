# Increment 2 Cockpit follow-up

**Status (2026-10-05): SHIPPED in Cockpit.** `ControlPlaneClient` declares `SUPPORTED_API_VERSION = "2.0"`, reads the bearer credential from `controlPlaneCredentialPath` (set with `CONTROL_PLANE_CREDENTIAL_PATH`) with the file-safety checks below, and applies the version policy (Cockpit #34). Verified against Cockpit main by a local session on 2026-10-05. The rest of this page is the original change request, kept as the record of what was asked.

This was the required stage-2 change for the separate Cockpit repository, blocked at the time on increment 1a’s compatibility-policy merge.

Apply this change to `ControlPlaneClient`:

```diff
-const SUPPORTED_API_VERSION = "1.0";
+const SUPPORTED_API_VERSION = "2.0";

+const credential = JSON.parse(await fs.readFile(config.controlPlaneCredentialPath, "utf8"));
+const active = credential.secrets.filter((x) => x.notAfter === null || Date.parse(x.notAfter) > Date.now()).at(-1);
+if (!active) throw new Error("No active control-plane credential");
 const response = await fetch(url, {
+  headers: { Authorization: `Bearer ${active.secret}` },
 });
+if (response.status === 401) {
+  const serverVersion = response.headers.get("X-Control-Plane-Api-Version");
+  throw new ControlPlaneCompatibilityError({ serverVersion, supportedVersion: SUPPORTED_API_VERSION });
+}
 const meta = await response.json();
+if (meta.authRequired !== true) throw new Error("Control plane did not advertise required authentication");
```

Add `controlPlaneCredentialPath` to Cockpit configuration and point it at the same workspace’s `api-credential.json`; do not copy the secret into Cockpit configuration, environment variables, logs, or telemetry. Validate the file as a regular, non-symlink file owned by the current uid with no group/world permission bits before reading it. Redact the loaded secret for the process lifetime.

Paper verification against the `2.0` contract: authenticated `GET /api/meta` returns `apiVersion: "2.0"`, `authRequired: true`, and the read plus command capabilities; unauthenticated requests return `401` with `X-Control-Plane-Api-Version: 2.0`; bearer credentials do not require browser-origin headers. Cockpit should request a read-only credential and must branch on `authRequired` before using other endpoints.
