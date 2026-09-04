# Increment 2 Cockpit follow-up

This is the required stage-2 change for the separate Cockpit repository. It is blocked on increment 1a’s compatibility-policy merge. Until it lands, Cockpit is not compatible with the authenticated `2.0` server.

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
