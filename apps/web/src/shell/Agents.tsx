import { useEffect, useState } from "react";
import { api, type Assistant, type CapabilityChange, type CatalogModel } from "../api.js";
import { Button, Card, QuotaBar, tokens } from "../ui.jsx";

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

export function Catalog() {
  const [assistants, setAssistants] = useState<Assistant[]>([]);
  const [cooldowns, setCooldowns] = useState<Array<{ assistantId: string; reason: string; until: string }>>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [changes, setChanges] = useState<CapabilityChange[]>([]);
  const [unavailable, setUnavailable] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = async () => {
    const [agents, limits, updates] = await Promise.allSettled([api.assistants(), api.cooldowns(), api.changes()]);
    setAssistants(agents.status === "fulfilled" ? agents.value : []);
    setCooldowns(limits.status === "fulfilled" ? limits.value : []);
    setChanges(updates.status === "fulfilled" ? updates.value : []);
    setUnavailable([agents.status === "rejected" ? "Assistant discovery" : "", limits.status === "rejected" ? "Cooldowns" : "", updates.status === "rejected" ? "Capability changes" : ""].filter(Boolean));
    setLoaded(true);
  };
  useEffect(() => { void load(); const timer = setInterval(() => void load(), 60_000); return () => clearInterval(timer); }, []);

  const sync = async (id: string) => {
    setBusy(id);
    setActionError(null);
    try {
      await api.syncAssistant(id);
      await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div style={{ display: "grid", gap: "0.8rem" }}>
      {!loaded && <p role="status">Reading configured environments…</p>}
      {!!unavailable.length && <p role="status" className="error">Unavailable: {unavailable.join(", ")}. Missing reads are not evidence of availability.</p>}
      {actionError && <p role="alert" className="error">{actionError}</p>}
      {loaded && !unavailable.includes("Assistant discovery") && assistants.length === 0 && <Card>No assistant environments configured.</Card>}
      {loaded && !unavailable.includes("Capability changes") && <details className="catalog-disclosure"><summary>What changed today</summary><Card>{changes.filter((c) => Date.now() - Date.parse(c.observed_at) < 86400000).length === 0 ? <p style={{ color: tokens.muted }}>No capability changes observed today.</p> : changes.filter((c) => Date.now() - Date.parse(c.observed_at) < 86400000).map((c, i) => <p key={i} style={{ fontSize: "0.83rem" }}><strong>{c.assistant_id}</strong>: {c.field} — {c.old_value || "(none)"} → {c.new_value || "(none)"}</p>)}</Card></details>}
      {assistants.map((a) => {
        const core = a.manifest?.core;
        const cooldown = cooldowns.find(
          (c) => c.assistantId === a.id && Date.parse(c.until) > Date.now(),
        );
        return (
          <Card key={a.id} style={cooldown ? { borderColor: `${tokens.warn}66` } : undefined}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.7rem" }}>
              <strong style={{ fontSize: "0.95rem" }}>{a.id}</strong>
              <span style={{ fontSize: "0.8rem", color: tokens.muted }}>{a.provider} · {a.enabled ? "Enabled" : "Disabled"}</span>
              {core && (
                <span
                  style={{
                    fontSize: "0.78rem",
                    color: core.auth.state === "ok" ? tokens.ok : tokens.danger,
                  }}
                >
                  auth: {core.auth.state}
                  {core.auth.account ? ` (${core.auth.account})` : ""}
                </span>
              )}
              <span style={{ marginLeft: "auto" }}>
                <Button variant="secondary" onClick={() => void sync(a.id)} disabled={busy === a.id}>
                  {busy === a.id ? "Syncing…" : "Sync"}
                </Button>
              </span>
            </div>
            {cooldown && (
              <p style={{ margin: "0.6rem 0 0", fontSize: "0.85rem", color: tokens.warn }}>
                Cooling down: {cooldown.reason} — routing will skip it until{" "}
                {new Date(cooldown.until).toLocaleTimeString()}.
              </p>
            )}
            {!core && (
              <p style={{ margin: "0.6rem 0 0", fontSize: "0.85rem", color: tokens.muted }}>
                No manifest yet — run a sync to discover capabilities.
              </p>
            )}
            {core && (
              <details className="catalog-disclosure"><summary>Models & capabilities</summary>
                <div style={{ marginTop: "0.6rem", fontSize: "0.83rem", color: tokens.muted }}>
                  models: {core.models.map((m) => m.id).join(", ") || "—"} · resume:{" "}
                  {String(core.canResume)} · mcp: {String(core.canMcp)} · reports limits:{" "}
                  <strong style={{ color: core.reportsLimits ? tokens.ok : tokens.warn }}>
                    {String(core.reportsLimits)}
                  </strong>{" "}
                  · mid-run input: {String(core.supportsMidRunInput)}
                </div>
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
          </Card>
        );
      })}
      <details className="catalog-disclosure"><summary>Model catalog & evidence</summary><ModelCatalogCard /></details>
    </div>
  );
}
