import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { Assistant } from "../api.js";
import { missionState, type Mission } from "./execution.js";
import {
  actualStatusLine,
  actualStatusShort,
  arcPath,
  describeState,
  shortFilterReason,
  visibleBodies,
  ringPath,
  SCENE,
  SPHERE_R,
  type ActualExecution,
  type FieldPulse,
  type ModelNode,
  type Ring,
} from "../orbital.js";

function useSize(ref: React.RefObject<HTMLElement | null>) {
  const [size, setSize] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setSize(entry!.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

export interface Satellite {
  assistant: Assistant;
  executing: boolean;
  cooling: boolean;
  /**
   * K13 SHADOW: this assistant is the model recommendation's "would choose" for
   * the selected mission, and it is NOT executing it. Rendered as a distinct,
   * non-running relationship so the field can never imply the shadow winner ran.
   */
  shadow?: boolean;
}

/** Outer band the assistant constellation and model candidates ride. Constant,
 *  not sphere-relative, so a bigger core never pushes labels off the page. */
const SAT_R = 430;
const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

/** Polar placement shared by SVG relationship lines (scene units) and the
 *  absolutely-positioned HTML nodes (percent of the scene box). The line
 *  endpoint is derived from the SAME clamped position, so a line always lands
 *  exactly on its node. */
function polar(angleDeg: number, radius: number) {
  const a = (angleDeg * Math.PI) / 180;
  const left = clamp((0.5 + (radius * Math.cos(a)) / SCENE) * 100, 5, 93);
  const top = clamp((0.5 + (radius * Math.sin(a)) / SCENE) * 100, 6, 94);
  return { left, top, sx: (left / 100) * SCENE, sy: (top / 100) * SCENE };
}

/**
 * Relationship path from the core to a node, bowed off the straight line by
 * `bow` scene units on the perpendicular. ACTUAL and SHADOW are given opposite
 * bows, so the two relationships stay separately legible even when they land on
 * the SAME model node (same assistant + selector). Curve, never a class swap —
 * ACTUAL stays solid, SHADOW stays dashed.
 */
function relPath(to: { sx: number; sy: number }, bow: number): string {
  const cx = SCENE / 2;
  const cy = SCENE / 2;
  const dx = to.sx - cx;
  const dy = to.sy - cy;
  const len = Math.hypot(dx, dy) || 1;
  const ox = (-dy / len) * bow;
  const oy = (dx / len) * bow;
  return `M ${cx} ${cy} Q ${(cx + to.sx) / 2 + ox} ${(cy + to.sy) / 2 + oy} ${to.sx} ${to.sy}`;
}

export function OrbitalField({
  tasks,
  selectedId,
  onSelect,
  pulse,
  satellites,
  totalTasks,
  models,
  actual,
}: {
  tasks: Mission[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  pulse: FieldPulse;
  satellites: Satellite[];
  totalTasks: number;
  /** K13 model candidates for the selected mission (empty ⇒ no recommendation). */
  models: ModelNode[];
  /** What actually executes / is routed for the selected mission. */
  actual: ActualExecution;
}) {
  const sceneRef = useRef<HTMLDivElement>(null);
  const size = useSize(sceneRef);
  const scale = size / SCENE;
  const bodies = visibleBodies(tasks, selectedId, scale || 1);

  // Model candidates ride the outer band, swept across the upper ~210° so the
  // ACTUAL and SHADOW relationships both stay above the fold at 1440×900.
  // Alternating radius gives them apparent orbital depth.
  // Candidates sweep the LEFT + TOP (‑200°…‑40°), never the right side where the
  // register and constellation live. Alternating radius (~54px) separates
  // neighbours in apparent depth; the winner lands mid‑left so the amber SHADOW
  // path is always the same reach. Everything stays above the 1440×900 fold.
  const n = Math.max(models.length, 1);
  const modelPlaced = models.map((m, i) => ({
    m,
    pos: polar(-200 + (160 * (i + 0.5)) / n, SAT_R + (i % 2 ? 0 : 54)),
  }));
  const shadowPos = modelPlaced.find(({ m }) => m.shadow)?.pos;
  // ACTUAL is an explicit relationship, never "nothing is executing". When a
  // concrete selector is running we anchor to that model node; otherwise to a
  // dedicated assistant-level chip (model unspecified — never invented), placed
  // lower‑left, clear of the candidate sweep.
  const actualNodePos = actual.modelSelector
    ? modelPlaced.find(({ m }) => m.actual && m.selector === actual.modelSelector)?.pos
    : undefined;
  const actualChipPos = actual.assistantId && !actualNodePos ? polar(-206, SAT_R - 62) : undefined;
  const actualPos = actualNodePos ?? actualChipPos;
  const live = pulse.running + pulse.attention + pulse.waiting + pulse.ready + pulse.unknown;
  const ringLen = 2 * Math.PI * (SPHERE_R + 14);
  const seg = (n: number) => (pulse.total ? (n / pulse.total) * ringLen : 0);
  const segments: Array<[number, string]> = [
    [seg(pulse.running), "var(--tone-active)"],
    [seg(pulse.attention), "var(--tone-human)"],
    [seg(pulse.waiting), "var(--tone-resource)"],
    [seg(pulse.ready + pulse.unknown), "var(--tone-neutral)"],
    [seg(pulse.settled), "var(--line-strong)"],
  ];
  let offset = 0;

  return (
    <>
    <div className="map-heading">
      <strong>Execution field</strong>
      <a href="#mission-register">{bodies.length} of {totalTasks} shown · register ↓</a>
    </div>
    <div
      ref={sceneRef}
      className={`sphere-scene ${pulse.running ? "is-executing" : ""}`}
      style={{ "--orbit-scale": scale } as CSSProperties}
    >
      <svg className="sphere-svg" viewBox={`0 0 ${SCENE} ${SCENE}`} aria-hidden="true">
        <defs>
          {/* Blue → violet core, deep but luminous. */}
          <radialGradient id="sph-body" cx="38%" cy="32%" r="74%">
            <stop offset="0" stopColor="#5b78e6" />
            <stop offset="0.34" stopColor="#354ac0" />
            <stop offset="0.6" stopColor="#241f78" />
            <stop offset="0.82" stopColor="#0f0e3a" />
            <stop offset="1" stopColor="#05061c" />
          </radialGradient>
          {/* Strong inner light so the core reads as a source, not a ball. */}
          <radialGradient id="sph-core" cx="45%" cy="43%" r="46%">
            <stop offset="0" stopColor="#eef2ff" stopOpacity="0.9" />
            <stop offset="0.26" stopColor="#93a6ff" stopOpacity="0.42" />
            <stop offset="0.62" stopColor="#5566e0" stopOpacity="0.1" />
            <stop offset="1" stopColor="#5566e0" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="sph-shade" cx="68%" cy="74%" r="62%">
            <stop offset="0.3" stopColor="#000" stopOpacity="0" />
            <stop offset="1" stopColor="#03041a" stopOpacity="0.82" />
          </radialGradient>
          <radialGradient id="sph-halo" cx="50%" cy="50%" r="50%">
            <stop offset="0.5" stopColor="#7f95ff" stopOpacity="0" />
            <stop offset="0.6" stopColor="#7f95ff" stopOpacity="0.18" />
            <stop offset="1" stopColor="#7f95ff" stopOpacity="0" />
          </radialGradient>
          <linearGradient id="sph-rim" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#e3e9ff" stopOpacity="0.9" />
            <stop offset="0.45" stopColor="#9fb0ff" stopOpacity="0.14" />
            <stop offset="1" stopColor="#9fb0ff" stopOpacity="0" />
          </linearGradient>
          <radialGradient id="sph-spec" cx="50%" cy="50%" r="50%">
            <stop offset="0" stopColor="#ffffff" stopOpacity="0.6" />
            <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="sph-energy" cx="50%" cy="50%" r="50%">
            <stop offset="0" stopColor="#9a7bff" stopOpacity="0.55" />
            <stop offset="1" stopColor="#9a7bff" stopOpacity="0" />
          </radialGradient>
          {/* Restrained amber/gold accent — a warm counter-light, not a theme. */}
          <radialGradient id="sph-amber" cx="50%" cy="50%" r="50%">
            <stop offset="0" stopColor="#ffce8a" stopOpacity="0.5" />
            <stop offset="1" stopColor="#ffce8a" stopOpacity="0" />
          </radialGradient>
          <linearGradient id="sph-arc" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#ffd79b" stopOpacity="0" />
            <stop offset="0.5" stopColor="#ffd79b" stopOpacity="0.8" />
            <stop offset="1" stopColor="#c9b6ff" stopOpacity="0" />
          </linearGradient>
          <clipPath id="sph-clip">
            <circle cx={SCENE / 2} cy={SCENE / 2} r={SPHERE_R} />
          </clipPath>
          <clipPath id="sph-front">
            <rect x="0" y={SCENE / 2} width={SCENE} height={SCENE / 2} />
          </clipPath>
          <filter id="sph-blur" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="26" />
          </filter>
          <filter id="sph-grain">
            <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" stitchTiles="stitch" />
            <feColorMatrix values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0.14 0" />
            <feComposite in2="SourceGraphic" operator="in" />
          </filter>
        </defs>

        {/* atmosphere */}
        <circle className="sph-atmos" cx={SCENE / 2} cy={SCENE / 2} r={SPHERE_R + 150} fill="url(#sph-halo)" />

        {/* layered translucent orbital shells — depth around the core */}
        {[1.07, 1.16, 1.28].map((k) => (
          <circle key={`shell${k}`} className="sph-shell" cx={SCENE / 2} cy={SCENE / 2} r={SPHERE_R * k} />
        ))}

        {/* orbits — back halves sit behind the sphere, front halves over it */}
        {[0, 1, 2].map((r) => (
          <path key={`b${r}`} className={`orbit orbit-${r} orbit-back`} d={ringPath(r as Ring)} />
        ))}

        {/* one gold arc passing BEHIND the core */}
        <path className="sph-arc sph-arc-back" d={arcPath(1, 0.52, 0.4)} stroke="url(#sph-arc)" />

        {/* sphere */}
        <circle cx={SCENE / 2} cy={SCENE / 2} r={SPHERE_R} fill="url(#sph-body)" />
        <g clipPath="url(#sph-clip)" className="sph-grid">
          {[0.18, 0.42, 0.7, 0.92].map((k) => (
            <ellipse key={`m${k}`} cx={SCENE / 2} cy={SCENE / 2} rx={SPHERE_R * k} ry={SPHERE_R} transform={`rotate(-18 ${SCENE / 2} ${SCENE / 2})`} />
          ))}
          {[-0.72, -0.4, 0, 0.4, 0.72].map((k) => (
            <ellipse key={`p${k}`} cx={SCENE / 2} cy={SCENE / 2 + SPHERE_R * k} rx={SPHERE_R * Math.sqrt(1 - k * k)} ry={SPHERE_R * 0.24 * Math.sqrt(1 - k * k)} transform={`rotate(-18 ${SCENE / 2} ${SCENE / 2})`} />
          ))}
        </g>
        <ellipse className="sph-energy" cx={SCENE / 2 + 40} cy={SCENE / 2 + 60} rx={SPHERE_R * 0.55} ry={SPHERE_R * 0.32} fill="url(#sph-energy)" filter="url(#sph-blur)" clipPath="url(#sph-clip)" />
        <ellipse className="sph-amber" cx={SCENE / 2 - 70} cy={SCENE / 2 + 110} rx={SPHERE_R * 0.42} ry={SPHERE_R * 0.3} fill="url(#sph-amber)" filter="url(#sph-blur)" clipPath="url(#sph-clip)" />
        <circle cx={SCENE / 2} cy={SCENE / 2} r={SPHERE_R} fill="url(#sph-shade)" />
        <circle cx={SCENE / 2} cy={SCENE / 2} r={SPHERE_R} fill="#fff" filter="url(#sph-grain)" opacity="0.45" clipPath="url(#sph-clip)" />
        <circle className="sph-corelight" cx={SCENE / 2} cy={SCENE / 2} r={SPHERE_R} fill="url(#sph-core)" clipPath="url(#sph-clip)" />
        <ellipse cx={SCENE / 2 - 84} cy={SCENE / 2 - 104} rx="104" ry="60" fill="url(#sph-spec)" filter="url(#sph-blur)" transform={`rotate(-30 ${SCENE / 2 - 84} ${SCENE / 2 - 104})`} />
        <circle cx={SCENE / 2} cy={SCENE / 2} r={SPHERE_R} fill="none" stroke="url(#sph-rim)" strokeWidth="1.75" />

        {/* one gold arc passing IN FRONT of the core */}
        <path className="sph-arc sph-arc-front" d={arcPath(0, 0.02, 0.42)} stroke="url(#sph-arc)" clipPath="url(#sph-front)" />

        {/* core ring: workload composition */}
        <circle className="core-track" cx={SCENE / 2} cy={SCENE / 2} r={SPHERE_R + 14} />
        {segments.map(([len, stroke], i) => {
          const el = len > 0 && (
            <circle key={i} className="core-seg" cx={SCENE / 2} cy={SCENE / 2} r={SPHERE_R + 14} stroke={stroke} strokeDasharray={`${Math.max(len - 6, 0)} ${ringLen}`} strokeDashoffset={-offset} />
          );
          offset += len;
          return el;
        })}

        {[0, 1, 2].map((r) => (
          <path key={`f${r}`} className={`orbit orbit-${r} orbit-front`} d={ringPath(r as Ring)} clipPath="url(#sph-front)" />
        ))}

        {/* semantic arcs: wake horizon for held tasks, blocker gap for quota */}
        {bodies.map(({ task, ring, phase }) => {
          if (task.state === "WAITING_RESOURCE")
            return (
              <g key={task.id}>
                <path className="arc-horizon" d={arcPath(ring, phase + 0.012, 0.11)} />
                {task.wait?.kind === "quota" && <path className="arc-blocker" d={arcPath(ring, phase - 0.09, 0.075)} />}
              </g>
            );
          if (task.state === "LIMIT_PAUSED") return <path key={task.id} className="arc-blocker" d={arcPath(ring, phase - 0.07, 0.14)} />;
          return null;
        })}

        {/* constellation track */}
        <circle className="constellation-track" cx={SCENE / 2} cy={SCENE / 2} r={SAT_R + 20} />

        {/* ACTUAL vs SHADOW relationships — solid teal for what runs, dashed
            amber for what K13 would choose. The two are always drawn together. */}
        {actualPos && (
          <path className="rel-line rel-actual" d={relPath(actualPos, 44)} />
        )}
        {shadowPos && (
          <path className="rel-line rel-shadow" d={relPath(shadowPos, -44)} />
        )}
      </svg>

      <div className="sphere-core" aria-live="polite">
        <span className="core-eyebrow">{pulse.running ? "Executing" : live ? "Holding" : "Idle"}</span>
        <strong>{String(live).padStart(2, "0")}</strong>
        <span className="core-sub">live missions</span>
      </div>

      {scale > 0 &&
        bodies.map(({ task, ring, phase, flip }) => {
          const state = missionState(task);
          const s = describeState(state);
          const moving = state === "RUNNING" || state === "ROUTING" || state === "HANDING_OFF";
          return (
            <button
              key={task.id}
              className={`orbital-body tone-${s.tone} state-${state} ${moving ? "moving" : ""} ${flip ? "flip" : ""} ${selectedId === task.id ? "selected" : ""}`}
              style={
                {
                  offsetPath: `path("${ringPath(ring, scale)}")`,
                  "--phase": phase,
                  "--ring": ring,
                } as CSSProperties
              }
              aria-label={`Select task: ${task.goal} · ${s.label}`}
              aria-pressed={selectedId === task.id}
              onClick={() => onSelect(task.id)}
            >
              <span className="body-dot" />
              <span className="body-label">
                <strong>{task.goal}</strong>
                <small>{s.label}</small>
              </span>
            </button>
          );
        })}

      {satellites.map(({ assistant, executing, cooling, shadow }, i) => {
        const availability = !assistant.enabled ? "disabled" : !assistant.manifest ? "availability unknown" : assistant.manifest.core.auth.state !== "ok" ? `auth ${assistant.manifest.core.auth.state}` : null;
        // Assistant constellation rides the top→right arc, opposite the model
        // candidates (which own the left + top) so the two never pile up.
        const a = ((-104 + (150 * (i + 0.5)) / satellites.length) * Math.PI) / 180;
        const x = clamp(50 + ((SAT_R - 34) * Math.cos(a) * 100) / SCENE, 5, 93);
        const y = clamp(50 + ((SAT_R - 34) * Math.sin(a) * 100) / SCENE, 6, 94);
        return (
          <div
            key={assistant.id}
            className={`satellite ${x > 52 ? "flip" : ""} ${executing ? "executing" : ""} ${cooling ? "cooling" : ""} ${availability ? "unavailable" : ""} ${shadow && !executing ? "shadow" : ""}`}
            style={{ left: `${x}%`, top: `${y}%` }}
            title={`${assistant.id} · ${assistant.provider}${availability ? ` · ${availability}` : ""}${cooling ? " · cooling down" : ""}${executing ? " · executing selected mission" : ""}${shadow && !executing ? " · K13 shadow: would choose (not executing)" : ""}`}
          >
            <i />
            <span>
              <strong>{assistant.id}</strong>
              <small>{[executing ? "executing" : "", shadow && !executing ? "shadow: would choose" : "", cooling ? "cooling down" : "", availability].filter(Boolean).join(" · ") || assistant.provider}</small>
            </span>
          </div>
        );
      })}

      {/* K13 model candidates: assistant + selector, with the SHADOW winner and
          any hard-filtered candidate reading distinctly from an eligible one. */}
      {modelPlaced.map(({ m, pos }) => {
        // ACTUAL pinned to THIS exact model (a concrete selector was requested
        // and it matches). Distinct from "actual, model unspecified", which is
        // carried by the assistant-level chip instead.
        const pinnedActual =
          m.actual && actual.modelSelector !== null && actual.modelSelector === m.selector;
        // One candidate identity, two independent relationships: ACTUAL and
        // SHADOW can both point at the same node. Neither fact is dropped.
        const both = pinnedActual && m.shadow;
        const isActualNode = pinnedActual && !m.shadow;
        const cls = !m.eligible
          ? "is-excluded"
          : both
            ? "is-actual is-shadow"
            : m.shadow
              ? "is-shadow"
              : isActualNode
                ? "is-actual"
                : m.priorMissing
                  ? "is-unproven"
                  : "is-eligible";
        const soloTag = !m.eligible
          ? `EXCLUDED · ${shortFilterReason(m.filterFailures)}`
          : m.shadow
            ? "SHADOW · would choose"
            : isActualNode
              ? `ACTUAL · ${actualStatusShort(actual.lifecycle)}`
              : m.priorMissing
                ? "eligible · prior unavailable"
                : `eligible${m.score !== undefined ? ` · ${m.score.toFixed(2)}` : ""}`;
        return (
          <div
            key={m.label}
            className={`model-node ${cls} ${pos.left > 52 ? "flip" : ""}`}
            style={{ left: `${pos.left}%`, top: `${pos.top}%` }}
            title={`${m.label}${m.score !== undefined ? ` · score ${m.score.toFixed(2)}` : ""}${
              m.eligible ? "" : ` · excluded: ${m.filterFailures.join(", ")}`
            }${pinnedActual ? ` · ACTUAL: ${actualStatusLine(actual.lifecycle)}` : ""}${
              m.shadow ? " · K13 SHADOW: would choose (not executing)" : ""
            }`}
          >
            <i />
            <span>
              <strong>
                {m.assistantId}/<em>{m.selector}</em>
              </strong>
              {both ? (
                <small className="dual-tag">
                  <span className="tag-actual">ACTUAL · {actualStatusShort(actual.lifecycle)}</span>
                  <span className="tag-shadow">SHADOW · would choose</span>
                </small>
              ) : (
                <small>{soloTag}</small>
              )}
            </span>
          </div>
        );
      })}

      {actualChipPos && (
        <div
          className={`model-node model-actual-chip is-actual ${actualChipPos.left > 52 ? "flip" : ""}`}
          style={{ left: `${actualChipPos.left}%`, top: `${actualChipPos.top}%` }}
          title={`Actual execution · ${actual.assistantId} · ${actualStatusLine(actual.lifecycle)}${actual.modelSelector ? ` · ${actual.modelSelector}` : " · model unspecified"}`}
        >
          <i />
          <span>
            <strong>ACTUAL · {actual.assistantId}</strong>
            <small>
              {actualStatusLine(actual.lifecycle)} ·{" "}
              {actual.modelSelector ?? "Model: unspecified"}
            </small>
          </span>
        </div>
      )}
    </div>
    </>
  );
}
