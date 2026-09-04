export class AuthExpiredError extends Error { constructor(){super("Session expired");this.name="AuthExpiredError";} }
const listeners=new Set<()=>void>();
export function onAuthExpired(listener:()=>void):()=>void{listeners.add(listener);return()=>listeners.delete(listener);}
export function emitAuthExpired():void{for(const listener of listeners)listener();}
