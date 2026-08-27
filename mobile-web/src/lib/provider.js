// Rows discovered outside the harness are Claude sessions and predate agentKind.
// Harness-owned and saved-provider rows always carry their explicit provider id.
export function providerKindOf(session) {
  if (session?.shell || session?.agentKind === 'shell') return 'shell';
  if (session?.agentKind) return session.agentKind;
  if (session?.kind === 'grok-saved') return 'grok';
  return 'claude';
}
