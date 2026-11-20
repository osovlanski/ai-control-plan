import { useEffect, useState } from "react";
import {
  api, type Assistant, type AssistantLifecycle, type CapabilityChange, type CatalogModel, type ConformanceResult,
  type RuntimeCatalog, type RuntimeCatalogEntry,
} from "../api.js";
import { Button, Card, QuotaBar, tokens } from "../ui.jsx";
import {
  agentStanding, agentTally, authText, configSnippet, conformanceText, enablementText, installedText, lifecycleDigest, statusTone, unconfiguredRuntimes,
} from "./runtime-registry.js";

/**
 * K7 model catalog card: evidence with its provenance, never a ranking. The
 * catalog says what is known about a model; provider discovery (above) remains
 * the authority for which assistant can serve it.
 */
function ModelCatalogCard() {
  const [models, setModels] = useState<CatalogModel[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    void api.models().then((r) => { setModels(r.models); setError(null); })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  };
  useEffect(load, []);

  const refresh = async () => {
    setBusy(true);
    try { await api.refreshModels(); load(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };

  return (
    <Card>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.7rem" }}>
        <strong>Model catalog</strong>
        <span style={{ fontSize: "0.8rem", color: tokens.muted }}>identity + price + external benchmark evidence (K7/K8)</span>
        <span style={{ marginLeft: "auto" }}>
          <Button variant="secondary" onClick={() => void refresh()} disabled={busy}>
            {busy ? "Refreshing…" : "Refresh"}
          </Button>
        </span>
      </div>
      <p className="fine-print">Catalog and benchmark evidence do not grant routing eligibility. Availability comes from configured assistant discovery.</p>
      {error && <p style={{ margin: "0.6rem 0 0", fontSize: "0.85rem", color: tokens.muted }}>Catalog unavailable: {error}. Routing is unaffected.</p>}
      {!error && models === null && <p role="status">Reading model catalog…</p>}
      {!error && models?.length === 0 && (
        <p style={{ margin: "0.6rem 0 0", fontSize: "0.85rem", color: tokens.muted }}>
          No catalog evidence yet — refresh to collect it from provider discovery and this workspace’s own runs.
        </p>
      )}
      {models?.map((m) => (
        <div key={m.modelKey} style={{ marginTop: "0.6rem", fontSize: "0.83rem", overflowWrap: "anywhere" }}>
          <strong>{m.modelId}</strong>{" "}
          <span style={{ color: tokens.muted }}>
            {m.provider} · {m.status} · {m.provenance.tier} via {m.provenance.source} · {m.freshness} · observed {m.provenance.observedAt}
            {/* Each fact names its own source: a filled gap is not the entry's evidence. */}
            {m.contextWindowTokens ? ` · advertised context ${m.contextWindowTokens.value} (${m.contextWindowTokens.provenance.source}; observed ${m.contextWindowTokens.provenance.observedAt})` : " · advertised context unknown"}
            {m.availableVia.length ? ` · via ${m.availableVia.join(", ")}` : " · no assistant advertises it"}
          </span>
          <div style={{ color: tokens.muted }}>
            {m.capabilities
              ? `Capabilities: ${Object.entries(m.capabilities.value).map(([key, value]) => `${key}: ${value}`).join(", ")} · ${m.capabilities.provenance.source} · observed ${m.capabilities.provenance.observedAt}`
              : "Capability evidence unavailable"}
          </div>
          {m.pricing.length === 0 && <div style={{ color: tokens.muted }}>Price evidence unavailable</div>}
          {m.pricing.map((p) => (
            <div key={p.pricingVersion} style={{ color: tokens.muted }}>
              price {p.inputPerMtok}/{p.outputPerMtok} {p.currency} per Mtok · version {p.pricingVersion} · {p.provenance.source} · {p.provenance.tier} · observed {p.provenance.observedAt} · {p.freshness}
              {p.appliesTo ? ` · applies to ${p.appliesTo.servingProvider}${p.appliesTo.accountKind ? `/${p.appliesTo.accountKind}` : ""}` : " · applicability not established"}
              {" · evidence only, not an enforcement tariff"}
            </div>
          ))}
          {/* K8: external benchmark priors. Prior evidence about intelligence — not a
              selection, not availability. Benchmark publication date, model release
              date and our fetch date are three separate facts and shown apart. */}
          {(m.benchmarkPriors ?? []).map((b, i) => (
            <div key={`${b.dimension}-${i}`} style={{ color: tokens.muted }}>
              {b.dimension} prior {b.normalized.toFixed(2)} · {b.provenance.source} · {b.provenance.tier}
              {b.provenance.benchmark ? ` · release ${b.provenance.benchmark.release}` : ""}
              {b.provenance.benchmark?.configuration ? ` (${b.provenance.benchmark.configuration})` : ""}
              {b.provenance.benchmark?.sourceSlug ? ` · aa-slug ${b.provenance.benchmark.sourceSlug}` : ""}
              {` · raw ${b.raw.value} ${b.raw.unit}`}
              {` · benchmark published ${b.provenance.benchmark?.publishedAt ?? "n/a"}`}
              {` · model released ${b.provenance.benchmark?.modelReleaseDate ?? "n/a"}`}
              {` · fetched ${b.provenance.observedAt.slice(0, 10)} · ${b.freshness}`}
              {b.provenance.attribution ? ` · ${b.provenance.attribution}` : ""}
            </div>
          ))}
        </div>
      ))}
    </Card>
  );
}

function Lifecycle({ lifecycle }: { lifecycle: AssistantLifecycle }) {
  const { readiness } = lifecycle;
  return (
    <>
      <dl className="runtime-lifecycle">
        <dt>Installed</dt>
        <dd>{installedText(lifecycle.installed)}{lifecycle.installed.observedAt ? ` · probed ${new Date(lifecycle.installed.observedAt).toLocaleString()}` : ""}</dd>
        <dt>Sign-in</dt>
        <dd style={{ color: lifecycle.auth.state === "ok" ? tokens.ok : tokens.warn }}>{authText(lifecycle.auth)}</dd>
        <dt>Conformance</dt>
        <dd>
          {conformanceText(lifecycle.conformance)}{lifecycle.conformance.checkedAt ? ` · tested ${new Date(lifecycle.conformance.checkedAt).toLocaleString()}` : ""}
          {lifecycle.conformance.state === "stale" && lifecycle.installed.state === "unknown" && (
            <div style={{ color: tokens.muted }}>No capability probe has observed a version yet, so a stored result cannot be matched to one.</div>
          )}
        </dd>
        <dt>Enablement</dt>
        <dd>{enablementText(lifecycle.enablement)}{lifecycle.enablement.operatorChangedAt ? ` · changed ${new Date(lifecycle.enablement.operatorChangedAt).toLocaleString()}` : ""}</dd>
        <dt>Ready</dt>
        <dd>
          <strong style={{ color: readiness.ready ? tokens.ok : tokens.danger }}>{readiness.ready ? "Yes" : "No"}</strong>
          {readiness.reasons.length > 0 && <ul className="runtime-reasons" aria-label="Why not ready">{readiness.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
        </dd>
      </dl>
      <p className="fine-print">Ready covers only checks that do not depend on a task. The router still decides each task against {lifecycle.requestDependent.join(", ")}.</p>
    </>
  );
}

function TestReport({ result }: { result: ConformanceResult }) {
  const tone = statusTone(result.status);
  return (
    <section className="runtime-test" aria-label={`Test result for ${result.assistantId}`}>
      <p style={{ margin: 0 }}>
        <strong style={{ color: tokens[tone] }}>Test {result.status}</strong>
        <span style={{ color: tokens.muted }}>
          {` · CLI ${result.cliVersion ?? "version not repeated"} · descriptor v${result.descriptorVersion} · ${new Date(result.checkedAt).toLocaleString()} · ${result.recorded ? "recorded" : "not recorded"}`}
        </span>
      </p>
      {result.reasons.length > 0 && <p style={{ margin: "0.3rem 0 0", color: tokens.muted }}>Reasons: {result.reasons.join(", ")}</p>}
      <div className="runtime-checks">
        <table>
          <thead><tr><th scope="col">Check</th><th scope="col">Result</th><th scope="col">Evidence</th><th scope="col">Reason</th></tr></thead>
          <tbody>
            {result.checks.map((c) => (
              <tr key={c.name}>
                <td>{c.name}</td>
                <td style={{ color: tokens[statusTone(c.status)] }}>{c.status}</td>
                <td>{c.level}</td>
                <td>{c.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="fine-print">A pass covers only the checks listed as pass. The test makes no model call and spends no quota.</p>
    </section>
  );
}

function AddRuntime({ entries, takenIds }: { entries: RuntimeCatalogEntry[]; takenIds: string[] }) {
  const [copied, setCopied] = useState<{ provider: string; ok: boolean } | null>(null);
  const copy = async (provider: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied({ provider, ok: true });
    } catch {
      setCopied({ provider, ok: false });
    }
  };
  return (
    <details className="catalog-disclosure">
      <summary>Add a runtime</summary>
      <p className="fine-print">
        The plane never installs a runtime, signs in or writes config. Install and sign in with the provider’s own tools,
        add the entry under the existing <code>assistants:</code> key in this workspace’s <code>config.yaml</code>, set any
        options the runtime needs, then restart the plane.
      </p>
      {entries.length === 0 && <Card>Every runtime in this build’s catalogue is already configured.</Card>}
      <div style={{ display: "grid", gap: "0.8rem", marginTop: "0.6rem" }}>
        {entries.map((r) => {
          const snippet = configSnippet(r.provider, takenIds);
          return (
            <Card key={r.provider}>
              <section aria-label={`Add ${r.label}`}>
                <div className="runtime-head">
                  <strong>{r.label}</strong>
                  <span style={{ fontSize: "0.8rem", color: tokens.muted }}>
                    {r.provider} · {r.maturity}{r.maturity === "scaffold" ? " (event mapping not proven)" : ""} · {r.transport}
                  </span>
                </div>
                <p style={{ margin: "0.5rem 0 0", fontSize: "0.83rem", color: tokens.muted }}>
                  {r.approvalModes.length ? `Enforces: ${r.approvalModes.join(", ")}` : "Enforces no approval mode"}
                  {` · conformance ${r.conformanceRequired ? "required before routing" : "not required"}`}
                </p>
                {r.docs?.install || r.docs?.auth ? (
                  <p style={{ margin: "0.4rem 0 0", fontSize: "0.83rem" }}>
                    {r.docs.install && <a href={r.docs.install} target="_blank" rel="noreferrer">Official install guide</a>}
                    {r.docs.install && r.docs.auth ? " · " : ""}
                    {r.docs.auth && <a href={r.docs.auth} target="_blank" rel="noreferrer">Official sign-in guide</a>}
                  </p>
                ) : (
                  <p style={{ margin: "0.4rem 0 0", fontSize: "0.83rem", color: tokens.muted }}>This build lists no official install or sign-in link for it.</p>
                )}
                <pre className="runtime-snippet" aria-label={`Config snippet for ${r.label}`}><code>{snippet}</code></pre>
                <div className="runtime-actions">
                  <Button variant="secondary" onClick={() => void copy(r.provider, snippet)}>Copy snippet</Button>
                  <span role="status" style={{ fontSize: "0.8rem", color: copied?.provider === r.provider && !copied.ok ? tokens.danger : tokens.muted }}>
                    {copied?.provider === r.provider ? (copied.ok ? "Copied." : "Copy failed: select the text and copy it.") : ""}
                  </span>
                </div>
              </section>
            </Card>
          );
        })}
      </div>
    </details>
  );
}

type Action = "sync" | "test" | "disable" | "enable";
const BUSY_TEXT: Record<Action, string> = { sync: "Syncing…", test: "Testing…", disable: "Disabling…", enable: "Enabling…" };

export function Catalog() {
  const [assistants, setAssistants] = useState<Assistant[]>([]);
  const [cooldowns, setCooldowns] = useState<Array<{ assistantId: string; reason: string; until: string }>>([]);
  const [busy, setBusy] = useState<{ id: string; action: Action } | null>(null);
  const [changes, setChanges] = useState<CapabilityChange[]>([]);
  const [catalog, setCatalog] = useState<RuntimeCatalog | null>(null);
  const [unavailable, setUnavailable] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, ConformanceResult>>({});
  // Rows are collapsed by default; a row opens on request, or when its own Test result arrives.
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) => setOpen((o) => { const next = new Set(o); if (!next.delete(id)) next.add(id); return next; });

  const load = async () => {
    const [agents, limits, updates, runtimes] = await Promise.allSettled([api.assistants(), api.cooldowns(), api.changes(), api.runtimeCatalog()]);
    setAssistants(agents.status === "fulfilled" ? agents.value : []);
    setCooldowns(limits.status === "fulfilled" ? limits.value : []);
    setChanges(updates.status === "fulfilled" ? updates.value : []);
    setCatalog(runtimes.status === "fulfilled" ? runtimes.value : null);
    setUnavailable([
      agents.status === "rejected" ? "Assistant discovery" : "",
      limits.status === "rejected" ? "Cooldowns" : "",
      updates.status === "rejected" ? "Capability changes" : "",
      runtimes.status === "rejected" ? "Runtime catalogue" : "",
    ].filter(Boolean));
    setLoaded(true);
  };
  useEffect(() => { void load(); const timer = setInterval(() => void load(), 60_000); return () => clearInterval(timer); }, []);

  // Every write route answers with the plane's re-read lifecycle: show it at once, so a test result
  // and the lifecycle beside it never disagree while the full re-read is in flight.
  const applyLifecycle = (id: string, lifecycle: AssistantLifecycle) =>
    setAssistants((list) => list.map((x) => (x.id === id ? { ...x, lifecycle } : x)));

  const act = async (a: Assistant, action: Action) => {
    setBusy({ id: a.id, action });
    setActionError(null);
    setNotice(null);
    try {
      if (action === "sync") await api.syncAssistant(a.id);
      if (action === "test") {
        const result = await api.testAssistant(a.id);
        setTests((t) => ({ ...t, [a.id]: result }));
        setOpen((o) => new Set(o).add(a.id));
        applyLifecycle(a.id, result.lifecycle);
        setNotice(`${a.id}: test ${result.status}.`);
      }
      if (action === "disable") {
        const r = await api.disableAssistant(a.id);
        applyLifecycle(a.id, r.lifecycle);
        setNotice(r.changed ? `${a.id} is disabled for future routing. Sessions already running are not stopped.` : `${a.id} was already disabled by operator.`);
      }
      if (action === "enable") {
        const r = await api.enableAssistant(a.id);
        applyLifecycle(a.id, r.lifecycle);
        const configNote = r.lifecycle.enablement.config ? "" : " Workspace config still disables it.";
        setNotice(`${a.id}: ${r.changed ? "operator override cleared." : "had no operator override."}${configNote}`);
      }
      await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const labels = new Map((catalog?.runtimes ?? []).map((r) => [r.provider, r.label]));
  const today = changes.filter((c) => Date.now() - Date.parse(c.observed_at) < 86400000);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: "0.8rem" }}>
      {!loaded && <p role="status">Reading configured environments…</p>}
      {!!unavailable.length && <p role="status" className="error">Unavailable: {unavailable.join(", ")}. Missing reads are not evidence of availability.</p>}
      {actionError && <p role="alert" className="error">{actionError}</p>}
      <p role="status" className="fine-print" style={{ margin: 0 }}>{notice ?? ""}</p>
      {loaded && !unavailable.includes("Assistant discovery") && assistants.length === 0 && <Card>No assistant environments configured.</Card>}
      {loaded && !unavailable.includes("Capability changes") && <details className="catalog-disclosure"><summary>What changed today</summary><Card>{today.length === 0 ? <p style={{ color: tokens.muted }}>No capability changes observed today.</p> : today.map((c, i) => <p key={i} style={{ fontSize: "0.83rem" }}><strong>{c.assistant_id}</strong>: {c.field} — {c.old_value || "(none)"} → {c.new_value || "(none)"}</p>)}</Card></details>}
      {assistants.length > 0 && (
        <div className="agent-toolbar">
          <span className="agent-tally">{agentTally(assistants.map((a) => agentStanding(a.lifecycle, a.enabled).label))}</span>
          <button type="button" className="agent-link" onClick={() => setOpen(open.size === assistants.length ? new Set() : new Set(assistants.map((a) => a.id)))}>
            {open.size === assistants.length ? "Collapse all" : "Expand all"}
          </button>
        </div>
      )}
      {assistants.length > 0 && <p className="fine-print" style={{ margin: 0 }}>Ready covers only checks that do not depend on a task. The router still decides each task.</p>}
      <div className="agent-list">
        {assistants.map((a) => {
          const core = a.manifest?.core;
          const lifecycle = a.lifecycle;
          const cooldown = cooldowns.find(
            (c) => c.assistantId === a.id && Date.parse(c.until) > Date.now(),
          );
          const mine = busy?.id === a.id;
          const operatorDisabled = lifecycle?.enablement.operator === "disabled";
          const borderColor = cooldown ? `${tokens.warn}66` : lifecycle && !lifecycle.enablement.effective ? `${tokens.danger}55` : undefined;
          const standing = agentStanding(lifecycle, a.enabled);
          const expanded = open.has(a.id);
          const panelId = `agent-details-${a.id}`;
          return (
            <Card key={a.id} style={borderColor ? { borderColor } : undefined}>
              <section aria-label={`Assistant ${a.id}`} className="agent-row">
                <div className="agent-summary">
                  <button type="button" className="agent-toggle" aria-expanded={expanded} aria-controls={panelId} onClick={() => toggle(a.id)}>
                    <span className="agent-chevron" aria-hidden="true">{expanded ? "▾" : "▸"}</span>
                    <strong>{a.id}</strong>
                    <span className="agent-sub">{labels.get(a.provider) ? `${labels.get(a.provider)} (${a.provider})` : a.provider}</span>
                  </button>
                  <span className="agent-chip" data-tone={standing.tone}>{standing.label}</span>
                  {core && (
                    <span className="agent-chip" data-tone={core.auth.state === "ok" ? "ok" : "danger"} title={core.auth.account ? `account ${core.auth.account}` : undefined}>
                      auth: {core.auth.state}
                    </span>
                  )}
                  <span className="runtime-actions agent-actions">
                    {lifecycle && (
                      <>
                        <Button variant="secondary" onClick={() => void act(a, "test")} disabled={!!busy}>
                          {mine && busy?.action === "test" ? BUSY_TEXT.test : "Test"}
                        </Button>
                        <Button variant={operatorDisabled ? "secondary" : "danger"} onClick={() => void act(a, operatorDisabled ? "enable" : "disable")} disabled={!!busy}>
                          {mine && (busy?.action === "disable" || busy?.action === "enable") ? BUSY_TEXT[busy.action] : operatorDisabled ? "Re-enable routing" : "Disable routing"}
                        </Button>
                      </>
                    )}
                    <Button variant="secondary" onClick={() => void act(a, "sync")} disabled={!!busy}>
                      {mine && busy?.action === "sync" ? BUSY_TEXT.sync : "Sync"}
                    </Button>
                  </span>
                </div>
                {lifecycle && !expanded && (
                  <p className="agent-digest">
                    {lifecycle.readiness.ready ? lifecycleDigest(lifecycle) : `${lifecycle.readiness.reasons.join(" · ")} · ${lifecycleDigest(lifecycle)}`}
                  </p>
                )}
                {cooldown && (
                  <p className="agent-cooldown">
                    Cooling down: {cooldown.reason} — routing will skip it until{" "}
                    {new Date(cooldown.until).toLocaleTimeString()}.
                  </p>
                )}
                <div id={panelId} hidden={!expanded} className="agent-details">
                  {lifecycle ? <Lifecycle lifecycle={lifecycle} /> : (
                    <p style={{ margin: "0.6rem 0 0", fontSize: "0.85rem", color: tokens.muted }}>
                      This plane serves no runtime lifecycle (API 2.10 or later), so Test and Disable are not offered.
                    </p>
                  )}
                  {tests[a.id] && <TestReport result={tests[a.id]!} />}
                  {!core && (
                    <p style={{ margin: "0.6rem 0 0", fontSize: "0.85rem", color: tokens.muted }}>
                      No manifest yet — run a sync to discover capabilities.
                    </p>
                  )}
                  {core && (
                    <details className="catalog-disclosure"><summary>Models & capabilities</summary>
                      <div style={{ marginTop: "0.6rem", fontSize: "0.83rem", color: tokens.muted }}>
                        {core.auth.account ? `account: ${core.auth.account} · ` : ""}models: {core.models.map((m) => m.id).join(", ") || "—"} · resume:{" "}
                        {String(core.canResume)} · mcp: {String(core.canMcp)} · reports limits:{" "}
                        <strong style={{ color: core.reportsLimits ? tokens.ok : tokens.warn }}>
                          {String(core.reportsLimits)}
                        </strong>{" "}
                        · adapter input flag: {String(core.supportsMidRunInput)}
                      </div>
                      <p className="fine-print">The input flag can cover approval replies. Free-text session delivery is not available through the task API.</p>
                      {core.limits?.map((l) => (
                        <div key={l.window} style={{ marginTop: "0.4rem" }}>
                          <QuotaBar usedPercent={l.usedPercent} resetsAt={l.resetsAt} />
                        </div>
                      ))}
                      {a.manifestUpdatedAt && (
                        <div style={{ marginTop: "0.5rem", fontSize: "0.78rem", color: tokens.muted }}>
                          last sync {new Date(a.manifestUpdatedAt).toLocaleString()}
                        </div>
                      )}
                    </details>
                  )}
                </div>
              </section>
            </Card>
          );
        })}
      </div>
      {loaded && catalog && !unavailable.includes("Assistant discovery") && (
        <AddRuntime entries={unconfiguredRuntimes(catalog.runtimes, assistants.map((a) => a.provider))} takenIds={assistants.map((a) => a.id)} />
      )}
      <details className="catalog-disclosure"><summary>Model catalog & evidence</summary><ModelCatalogCard /></details>
    </div>
  );
}
