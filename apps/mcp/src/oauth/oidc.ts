/**
 * The MCP service's OIDC relying party (D-A: Google). The client and the exact (iss, sub) pin are
 * shared with the Web remote login so the two cannot drift: see packages/oidc.
 */
export { OidcClient, ownerPinMatches, s256, type OidcClientOptions, type OwnerPin } from "@agent-plane/oidc";
