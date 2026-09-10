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
          {/* Directional volume: cool upper-left, dark interior, warm lower-right. */}
          <radialGradient id="sph-body" cx="28%" cy="24%" r="82%">
            <stop offset="0" stopColor="#637be7" />
            <stop offset="0.28" stopColor="#303b91" />
            <stop offset="0.55" stopColor="#121834" />
            <stop offset="0.8" stopColor="#080d20" />
            <stop offset="1" stopColor="#241932" />
          </radialGradient>
          <radialGradient id="sph-halo">
            <stop offset="0" stopColor="#667dff" stopOpacity="0.48" />
            <stop offset="0.58" stopColor="#5144d9" stopOpacity="0.15" />
            <stop offset="1" stopColor="#5144d9" stopOpacity="0" />
          </radialGradient>
          <linearGradient id="sph-rim" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#e0f0ff" />
            <stop offset="0.3" stopColor="#7d92ff" />
            <stop offset="0.65" stopColor="#7561ee" stopOpacity="0.12" />
            <stop offset="1" stopColor="#ffd79c" stopOpacity="0.7" />
          </linearGradient>
          <linearGradient id="sph-ribbon" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#d6e8ff" />
            <stop offset="0.25" stopColor="#8daaff" />
            <stop offset="0.55" stopColor="#7654ff" />
            <stop offset="0.8" stopColor="#394bca" stopOpacity="0.5" />
            <stop offset="1" stopColor="#91cfff" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="sph-shell" x1="0" y1="0" x2="0.8" y2="1">
            <stop offset="0" stopColor="#e0edff" stopOpacity="0.72" />
            <stop offset="0.24" stopColor="#97a1ff" stopOpacity="0.4" />
            <stop offset="0.55" stopColor="#6d53d7" stopOpacity="0.06" />
            <stop offset="0.85" stopColor="#5a7eff" stopOpacity="0.32" />
            <stop offset="1" stopColor="#c5d7ff" stopOpacity="0.65" />
          </linearGradient>
          <linearGradient id="sph-gold" x1="0" y1="0" x2="1" y2="0.6">
            <stop offset="0" stopColor="#c87840" stopOpacity="0" />
            <stop offset="0.45" stopColor="#bf793d" stopOpacity="0.24" />
            <stop offset="0.78" stopColor="#f6b969" stopOpacity="0.8" />
            <stop offset="0.92" stopColor="#fff0cc" />
            <stop offset="1" stopColor="#e7a861" stopOpacity="0.4" />
          </linearGradient>
          <radialGradient id="sph-amber">
            <stop offset="0" stopColor="#ffb85c" stopOpacity="0.7" />
            <stop offset="1" stopColor="#dd813c" stopOpacity="0" />
          </radialGradient>
          <linearGradient id="sph-arc" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#93adff" stopOpacity="0.1" />
            <stop offset="0.45" stopColor="#dceeff" />
            <stop offset="0.75" stopColor="#91aaff" stopOpacity="0.8" />
            <stop offset="1" stopColor="#b6c5ff" stopOpacity="0.2" />
          </linearGradient>
          {/* Tapered ribbons, reused only for a soft light spill and a crisp surface. */}
          <path id="sph-flow-a" d="M 240 470 C 214 287 455 156 617 268 C 733 348 692 517 572 635 C 461 744 314 719 313 620 C 278 733 457 794 601 650 C 757 495 773 329 637 240 C 452 119 179 293 240 470 Z" />
          <path id="sph-flow-b" d="M 291 690 C 410 799 737 598 739 403 C 742 302 643 293 548 333 C 672 258 778 304 762 422 C 735 646 426 838 291 690 Z" />
          <path id="sph-flow-c" d="M 285 369 C 435 205 674 405 627 592 C 603 690 490 730 418 690 C 530 728 632 612 607 504 C 577 372 387 254 285 369 Z" />
          <clipPath id="sph-clip">
            <circle cx={SCENE / 2} cy={SCENE / 2} r={SPHERE_R} />
          </clipPath>
          <clipPath id="sph-front">
            <rect x="0" y={SCENE / 2} width={SCENE} height={SCENE / 2} />
          </clipPath>
          <filter id="sph-blur" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="26" />
          </filter>
          <filter id="sph-soft" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="8" />
          </filter>
          <mask id="sph-shell-depth">
            <rect width={SCENE} height={SCENE} fill="white" />
            <ellipse cx="535" cy="465" rx="157" ry="206" transform="rotate(32 535 465)" fill="black" filter="url(#sph-soft)" />
          </mask>
        </defs>

        {/* Asymmetric atmosphere extends beyond the physical volume. */}
        <g className="sph-atmos">
          <ellipse cx="420" cy="440" rx="418" ry="360" transform="rotate(-32 420 440)" fill="url(#sph-halo)" />
          <ellipse cx="708" cy="635" rx="156" ry="225" transform="rotate(32 708 635)" fill="url(#sph-amber)" opacity="0.35" />
        </g>

        {/* Full orbital paths go behind the opaque core; their near halves
            are drawn after the volume. No relationship semantics change. */}
        {[0, 1, 2].map((r) => (
          <path key={`b${r}`} className={`orbit orbit-${r} orbit-back`} d={ringPath(r as Ring)} />
        ))}
        <ellipse cx="500" cy="500" rx="397" ry="155" transform="rotate(-32 500 500)" fill="none" stroke="url(#sph-arc)" strokeWidth="3" opacity="0.55" />

        <circle cx={SCENE / 2} cy={SCENE / 2} r={SPHERE_R} fill="url(#sph-body)" />
        <g clipPath="url(#sph-clip)">
          {/* Rear shell: broad glass surface, softened where it turns away. */}
          <path d="M 210 464 C 180 253 494 126 682 270 C 538 188 292 356 348 606 C 300 596 232 538 210 464 Z" fill="url(#sph-shell)" opacity="0.42" />
          <g fill="url(#sph-ribbon)" filter="url(#sph-soft)" opacity="0.8">
            <use href="#sph-flow-a" />
            <use href="#sph-flow-b" />
            <use href="#sph-flow-c" />
          </g>
          <g fill="url(#sph-ribbon)">
            <use href="#sph-flow-a" />
            <use href="#sph-flow-b" opacity="0.75" />
            <use href="#sph-flow-c" opacity="0.6" />
          </g>
          {/* Inner filaments trace curved energy, leaving a dark readable core. */}
          <g fill="none" stroke="url(#sph-ribbon)" strokeWidth="1.6">
            <path d="M 249 447 C 248 258 507 204 640 322 S 617 705 404 718" />
            <path d="M 267 465 C 226 304 462 206 609 315 S 650 629 491 704" />
            <path d="M 315 353 C 464 250 686 460 598 621 S 382 752 337 662" />
            <path d="M 333 347 C 484 290 633 465 581 586 S 432 723 382 686" />
            <path d="M 259 614 C 316 777 662 622 722 434" />
          </g>
          {/* Opposite light is a surface reflection as well as a soft spill. */}
          <ellipse cx="731" cy="621" rx="130" ry="202" transform="rotate(30 731 621)" fill="url(#sph-amber)" />
          <path d="M 443 766 C 642 799 798 549 736 388 C 854 539 700 821 514 806 Z" fill="url(#sph-gold)" />
          <path d="M 463 780 C 657 779 792 550 751 421" fill="none" stroke="url(#sph-gold)" strokeWidth="5" />
          {/* Two near shells cross the inner ribbons; the mask loses their
              far surfaces behind the core instead of drawing concentric rings. */}
          <g mask="url(#sph-shell-depth)">
            <path d="M 248 552 C 226 405 373 214 543 224 C 398 277 322 451 338 591 C 351 711 493 775 667 715 C 466 856 276 757 248 552 Z" fill="url(#sph-shell)" />
            <path d="M 299 693 C 482 789 793 523 758 363 C 849 542 517 844 332 738 Z" fill="url(#sph-shell)" opacity="0.8" />
          </g>
          <path d="M 240 440 C 234 319 373 208 512 207" fill="none" stroke="#bbd7ff" strokeWidth="4" filter="url(#sph-soft)" />
          <path d="M 240 440 C 234 319 373 208 512 207" fill="none" stroke="url(#sph-rim)" strokeWidth="2.5" />
        </g>
        <circle cx={SCENE / 2} cy={SCENE / 2} r={SPHERE_R} fill="none" stroke="url(#sph-rim)" strokeWidth="2.5" />

        {/* Near side of the tilted orbit crosses in front, with an opaque
            dark under-stroke that separates it from the inner energy. */}
        <path d="M 163 710 A 397 155 -32 0 0 837 290" fill="none" stroke="#0b122a" strokeWidth="9" opacity="0.65" />
        <path className="sph-arc sph-arc-front" d="M 163 710 A 397 155 -32 0 0 837 290" stroke="url(#sph-arc)" />

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
