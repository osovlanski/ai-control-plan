import { loadConfig } from "../config.js";
import { credentialPath, rotateCredential } from "../auth/credential-file.js";

const config=loadConfig();
const at=process.argv.indexOf("--capabilities");
const capabilities=at<0?undefined:(process.argv[at+1]??"").split(",").filter(Boolean);
rotateCredential(credentialPath(config.dir),config.api.auth.rotationGraceSeconds,capabilities);
process.stdout.write(`Rotated credential file ${credentialPath(config.dir)}\n`);
