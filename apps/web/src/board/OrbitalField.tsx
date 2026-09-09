import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { Assistant } from "../api.js";
import { missionState, type Mission } from "./execution.js";
import {
  arcPath,
  describeState,
  visibleBodies,
  ringPath,
  SCENE,
  SPHERE_R,
  type FieldPulse,
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

export function OrbitalField({
  tasks,
  selectedId,
  onSelect,
  pulse,
  satellites,
  totalTasks,
}: {
  tasks: Mission[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  pulse: FieldPulse;
  satellites: Satellite[];
  totalTasks: number;
}) {
  const sceneRef = useRef<HTMLDivElement>(null);
  const size = useSize(sceneRef);
  const scale = size / SCENE;
  const bodies = visibleBodies(tasks, selectedId, scale || 1);
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
          <radialGradient id="sph-body" cx="36%" cy="30%" r="72%">
            <stop offset="0" stopColor="#2f5a66" />
            <stop offset="0.4" stopColor="#12303b" />
            <stop offset="0.8" stopColor="#081218" />
            <stop offset="1" stopColor="#04080b" />
          </radialGradient>
          <radialGradient id="sph-shade" cx="68%" cy="72%" r="60%">
            <stop offset="0.3" stopColor="#000" stopOpacity="0" />
            <stop offset="1" stopColor="#000" stopOpacity="0.8" />
          </radialGradient>
          <radialGradient id="sph-halo" cx="50%" cy="50%" r="50%">
            <stop offset="0.62" stopColor="#7fe3dc" stopOpacity="0" />
            <stop offset="0.66" stopColor="#7fe3dc" stopOpacity="0.22" />
            <stop offset="1" stopColor="#7fe3dc" stopOpacity="0" />
          </radialGradient>
          <linearGradient id="sph-rim" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#b9f3ee" stopOpacity="0.85" />
            <stop offset="0.45" stopColor="#7fe3dc" stopOpacity="0.12" />
            <stop offset="1" stopColor="#7fe3dc" stopOpacity="0" />
          </linearGradient>
          <radialGradient id="sph-spec" cx="50%" cy="50%" r="50%">
            <stop offset="0" stopColor="#dffdfa" stopOpacity="0.55" />
            <stop offset="1" stopColor="#dffdfa" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="sph-energy" cx="50%" cy="50%" r="50%">
            <stop offset="0" stopColor="#7fe3dc" stopOpacity="0.5" />
            <stop offset="1" stopColor="#7fe3dc" stopOpacity="0" />
          </radialGradient>
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
            <feColorMatrix values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0.16 0" />
            <feComposite in2="SourceGraphic" operator="in" />
          </filter>
        </defs>

        {/* atmosphere */}
        <circle className="sph-atmos" cx={SCENE / 2} cy={SCENE / 2} r={SPHERE_R + 120} fill="url(#sph-halo)" />

        {/* orbits — back halves sit behind the sphere, front halves over it */}
        {[0, 1, 2].map((r) => (
          <path key={`b${r}`} className={`orbit orbit-${r} orbit-back`} d={ringPath(r as Ring)} />
        ))}

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
        <circle cx={SCENE / 2} cy={SCENE / 2} r={SPHERE_R} fill="url(#sph-shade)" />
        <circle cx={SCENE / 2} cy={SCENE / 2} r={SPHERE_R} fill="#fff" filter="url(#sph-grain)" opacity="0.5" />
        <ellipse cx={SCENE / 2 - 80} cy={SCENE / 2 - 100} rx="100" ry="58" fill="url(#sph-spec)" filter="url(#sph-blur)" transform={`rotate(-30 ${SCENE / 2 - 80} ${SCENE / 2 - 100})`} />
        <circle cx={SCENE / 2} cy={SCENE / 2} r={SPHERE_R} fill="none" stroke="url(#sph-rim)" strokeWidth="1.5" />

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
        <circle className="constellation-track" cx={SCENE / 2} cy={SCENE / 2} r={SPHERE_R + 250} />
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
        const a = ((-150 + (120 * (i + 0.5)) / satellites.length) * Math.PI) / 180;
        const x = 50 + ((SPHERE_R + 250) * Math.cos(a) * 100) / SCENE;
        const y = 50 + ((SPHERE_R + 250) * Math.sin(a) * 100) / SCENE;
        return (
          <div
            key={assistant.id}
            className={`satellite ${executing ? "executing" : ""} ${cooling ? "cooling" : ""} ${availability ? "unavailable" : ""} ${shadow && !executing ? "shadow" : ""}`}
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
    </div>
    </>
  );
}
