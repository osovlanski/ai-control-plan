import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AssistantId, ExecutionRequest, TaskId, VerificationPlan } from "@agent-plane/core";
import { openDb, type Db } from "../../src/db/index.js";
import { SessionStore } from "../../src/modules/harness/session-store.js";
import { VerificationStore, VerificationStoreConflictError } from "../../src/modules/harness/verification-store.js";

let dir: string; let db: Db; let store: VerificationStore; let sessionId: string;
const request = (id = "erq_1"): ExecutionRequest => ({
  schemaVersion:1, executionRequestId:id, taskId:"AG-1" as TaskId, attempt:1,
  assistantId:"a1" as AssistantId, routingDecisionRef:"rd_1",
  runSpec:{ taskId:"AG-1" as TaskId, prompt:"do it", workdir:"/tmp/wt", permissionPolicy:{mode:"auto-approve"}, env:{redactionRules:[],maxRuntimeMs:1000} },
  policy:{ budget:{enforcement:"advisory"}, timeout:{hardMs:1000}, approval:{mode:"auto-approve"}, tools:{mode:"audit"}, checkpoint:{onSoftLimit:true}, isolation:{required:"partial"} },
  context:{}, verification:[], origin:{kind:"fresh"},
});
const plan = (id="vpr_1", revision=1, supersedesRevisionId?:string): VerificationPlan & {planRevisionId:string;revision:number} => ({
  schemaVersion:1, planRevisionId:id, revision, ...(supersedesRevisionId ? {supersedesRevisionId}:{}),
  checks:[{checkId:"tests",name:"tests",kind:"tests",command:"pnpm test",required:true}],
  decisions:[{checkId:"tests",selected:true,required:true,signals:["changed"],reason:"source changed"}],
});

beforeEach(() => {
  dir=mkdtempSync(join(tmpdir(),"verification-store-")); db=openDb(join(dir,"test.db"));
  db.prepare("INSERT INTO assistants (id, provider) VALUES ('a1','fake')").run();
  db.prepare("INSERT INTO tasks (id,goal,envelope,created_at,updated_at) VALUES ('AG-1','g','{}','t','t')").run();
  const sessions=new SessionStore(db,()=>new Date("2026-01-01T00:00:00.000Z")); sessions.recordRequest(request());
  sessionId=sessions.createSession("erq_1").sessionId; store=new VerificationStore(db,()=>new Date("2026-01-02T00:00:00.000Z"));
});
afterEach(()=>{db.close();rmSync(dir,{recursive:true,force:true});});

describe("VerificationStore",()=>{
  it("inserts immutable revisions idempotently and enforces predecessor ancestry",()=>{
    expect(store.insertRevision({sessionId,executionRequestId:"erq_1",plan:plan(),reason:"initial"}).deduped).toBe(false);
    expect(store.insertRevision({sessionId,executionRequestId:"erq_1",plan:plan(),reason:"initial"}).deduped).toBe(true);
    expect(()=>db.prepare("UPDATE verification_plan_revisions SET reason='recovery' WHERE id='vpr_1'").run()).toThrow("immutable");
    expect(()=>store.insertRevision({sessionId,executionRequestId:"erq_1",plan:plan("vpr_3",3,"vpr_1"),reason:"post_change"})).toThrow("predecessor mismatch");
  });

  it("enforces session/request/revision foreign bindings",()=>{
    expect(()=>store.insertRevision({sessionId,executionRequestId:"missing",plan:plan(),reason:"initial"})).toThrow();
    store.insertRevision({sessionId,executionRequestId:"erq_1",plan:plan(),reason:"initial"});
    expect(()=>store.prepareRun({runId:"vr_1",sessionId,executionRequestId:"wrong",planRevisionId:"vpr_1"})).toThrow("binding mismatch");
  });

  it("rejects direct revision inserts whose JSON identity is missing or mistyped",()=>{
    const insert=db.prepare(`INSERT INTO verification_plan_revisions
      (id,session_id,execution_request_id,revision,plan_fingerprint,fingerprint_algorithm,plan,reason,created_at)
      VALUES ('raw',?,'erq_1',1,'fp','sha256-canonical-verification-plan-v1',?,'initial','t')`);
    expect(()=>insert.run(sessionId,JSON.stringify({schemaVersion:1,checks:[],decisions:[]}))).toThrow();
    expect(()=>insert.run(sessionId,JSON.stringify({schemaVersion:1,planRevisionId:"raw",revision:"1",planFingerprint:"fp",fingerprintAlgorithm:"sha256-canonical-verification-plan-v1",checks:[],decisions:[]}))).toThrow();
  });

  it("dedupes prepare/claim and rejects wrong bindings or stale transitions",()=>{
    store.insertRevision({sessionId,executionRequestId:"erq_1",plan:plan(),reason:"initial"});
    const input={runId:"vr_1",sessionId,executionRequestId:"erq_1",planRevisionId:"vpr_1"};
    expect(store.prepareRun(input).deduped).toBe(false); expect(store.prepareRun(input).deduped).toBe(true);
    expect(store.claim({...input,claimToken:"owner"}).deduped).toBe(false);
    expect(store.claim({...input,claimToken:"owner"}).deduped).toBe(true);
    expect(()=>store.claim({...input,runId:"missing",claimToken:" "})).toThrow("claim token must not be blank");
    expect(()=>store.claim({...input,claimToken:"stale"})).toThrow(VerificationStoreConflictError);
    expect(()=>store.complete({...input,claimToken:"stale",evaluation:{passed:true,checks:[]},artifacts:[]})).toThrow("stale settlement");
  });

  it("persists redacted canonical evaluation and artifact references",()=>{
    store.insertRevision({sessionId,executionRequestId:"erq_1",plan:plan(),reason:"initial"});
    const input={runId:"vr_1",sessionId,executionRequestId:"erq_1",planRevisionId:"vpr_1",claimToken:"owner"};
    store.prepareRun(input); store.claim(input);
    const outcome: Parameters<VerificationStore["complete"]>[0]={...input,evaluation:{passed:false,checks:[{checkId:"tests",name:"tests",kind:"tests",passed:false,status:"failed",required:true,summary:"token sk-secret-value"}]},artifacts:[{kind:"test_report",ref:"artifact://sk-secret-value",summary:"failed sk-secret-value"}]};
    const completed=store.complete(outcome);
    expect(completed.state).toBe("completed"); expect(JSON.stringify(completed)).not.toContain("sk-secret-value");
    expect(completed.evaluation?.passed).toBe(false); expect(completed.artifacts).toHaveLength(1);
    expect(completed.evaluation?.checks[0]).not.toHaveProperty("injected");
    expect(completed.artifacts[0]).not.toHaveProperty("inlineData");
    expect(store.complete(outcome)).toEqual(completed);
  });

  it("validates and bounds evidence before persistence",()=>{
    store.insertRevision({sessionId,executionRequestId:"erq_1",plan:plan(),reason:"initial"});
    const input={runId:"vr_1",sessionId,executionRequestId:"erq_1",planRevisionId:"vpr_1",claimToken:"owner"};
    store.prepareRun(input);store.claim(input);
    const extraCheck={checkId:"tests",name:"tests",kind:"tests",passed:true,status:"passed",required:true,summary:"ok",injected:"secret"};
    const extraArtifact={kind:"test_report",ref:"artifact://report",summary:"ok",inlineData:"must not persist"};
    const completed=store.complete({...input,evaluation:{passed:false,checks:[extraCheck] as never},artifacts:[extraArtifact] as never});
    expect(completed.evaluation?.passed).toBe(true);
    expect(completed.evaluation?.checks[0]).not.toHaveProperty("injected");
    expect(completed.artifacts[0]).not.toHaveProperty("inlineData");

    const nextPlan=plan("vpr_2",2,"vpr_1");
    store.insertRevision({sessionId,executionRequestId:"erq_1",plan:nextPlan,reason:"post_change"});
    const second={...input,runId:"vr_2",planRevisionId:"vpr_2"}; store.prepareRun(second);store.claim(second);
    expect(()=>store.complete({...second,evaluation:{passed:true,checks:[{...extraCheck,status:"failed",passed:true}] as never},artifacts:[]})).toThrow("invalid verification check");
    expect(()=>store.complete({...second,evaluation:{passed:false,checks:[null] as never},artifacts:[]})).toThrow(VerificationStoreConflictError);
    expect(()=>store.complete({...second,evaluation:{passed:true,checks:[]},artifacts:[null] as never})).toThrow(VerificationStoreConflictError);
    expect(()=>store.complete({...second,evaluation:{passed:true,checks:Array.from({length:101},()=>extraCheck) as never},artifacts:[]})).toThrow("at most 100 checks");
    const oversizedArtifacts=Array.from({length:100},(_,i)=>({...extraArtifact,ref:`artifact://${i}${"x".repeat(3000)}`,summary:`${i}${"x".repeat(3000)}`}));
    expect(()=>store.complete({...second,evaluation:{passed:true,checks:[]},artifacts:oversizedArtifacts as never})).toThrow("exceeds 262144 bytes");
  });

  it("records interrupted runs without fabricating evaluation evidence",()=>{
    store.insertRevision({sessionId,executionRequestId:"erq_1",plan:plan(),reason:"initial"});
    const input={runId:"vr_1",sessionId,executionRequestId:"erq_1",planRevisionId:"vpr_1",claimToken:"owner"};
    store.prepareRun(input);store.claim(input);
    expect(()=>store.interrupt({...input,reason:"  "})).toThrow("interruption reason must not be blank");
    const interrupted=store.interrupt({...input,reason:"worker lost sk-secret-value"});
    expect(interrupted).toMatchObject({state:"interrupted",artifacts:[]});
    expect(interrupted).not.toHaveProperty("evaluation"); expect(interrupted.interruptionReason).not.toContain("sk-secret-value");
    expect(store.interrupt({...input,reason:"worker lost sk-secret-value"})).toEqual(interrupted);
    expect(()=>store.complete({...input,evaluation:{passed:true,checks:[]},artifacts:[]})).toThrow("stale settlement");
  });
});
