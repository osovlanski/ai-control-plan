import { loadConfig } from "../config.js";
import { credentialPath, namedCredentialPath, rotateCredential, rotateNamedCredential } from "../auth/credential-file.js";

// Usage: rotate-credential [--capabilities a,b] [--name <name>]
// `--name mcp` mints or rotates the narrow MCP credential (api-credential.mcp.json; default
// capabilities tasks.read,tasks.create,tasks.start). Without --name the main credential rotates
// and named credentials are left untouched.
const config=loadConfig();
const arg=(flag:string)=>{ const at=process.argv.indexOf(flag); return at<0?undefined:(process.argv[at+1]??""); };
const caps=arg("--capabilities");
const capabilities=caps===undefined?undefined:caps.split(",").filter(Boolean);
const name=arg("--name");
if(name!==undefined){
  const path=namedCredentialPath(config.dir,name);
  const next=rotateNamedCredential(config.dir,name,config.api.auth.rotationGraceSeconds,capabilities);
  process.stdout.write(`Rotated credential file ${path} (kid ${next.kid}: ${next.capabilities.join(",")})\n`);
} else {
  rotateCredential(credentialPath(config.dir),config.api.auth.rotationGraceSeconds,capabilities);
  process.stdout.write(`Rotated credential file ${credentialPath(config.dir)}\n`);
}
