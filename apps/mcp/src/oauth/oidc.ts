/**
 * The MCP service as an OIDC relying party of the owner's identity provider (D-A: Google).
 * The client and the (iss, sub) pin live in `@agent-plane/core/oidc`, shared with the Web's remote
 * login in apps/api, so the two logins cannot drift apart.
 */
export { OidcClient, isPinnedOwner, s256 } from "@agent-plane/core/oidc";
