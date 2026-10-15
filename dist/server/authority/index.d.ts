export { partitionGuard, defineChannelFamilies, DEFAULT_FAMILY_SERVICES, DEFAULT_EPHEMERAL_SERVICES, } from './families';
export type { ChannelKind, GuardAuth, ShapeGuard, ChannelShapeGuard, ChannelFamily, ChannelFamilies, NamespaceRule, PartitionGuardOptions, DefineChannelFamiliesOptions, } from './families';
export { createChannelAuthority, normalizeCallPayload } from './engine';
export type { AuthorityContext, AuthorityStepResult, AuthorityKit, ChannelQuestion, CallQuestion, ChannelStep, CallStep, ChannelAuthorization, ChannelNamespaceHandler, CreateChannelAuthorityOptions, ChannelAuthority, LobbyVerdict, } from './engine';
export { principalIsCurrent, revalidatingAuth, withPrincipalRevalidation, gateOnPrincipal } from './principal';
export type { PrincipalRevalidation, FeaturePrincipal } from './principal';
export { withAuthorityCache } from './verdictCache';
export type { AuthorityCacheOptions, AuthorityCacheStats, AuthorityVerdictCache } from './verdictCache';
export { BEARER_SUBPROTOCOL, tokenFromSubprotocol, bearerSubprotocolAuth } from './bearer';
export type { RealtimeAuthContext, BearerSubprotocolAuthOptions } from './bearer';
//# sourceMappingURL=index.d.ts.map