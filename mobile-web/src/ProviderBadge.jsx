import React from 'react';
import anthropicIcon from './assets/providers/anthropic.png';
import openaiIcon from './assets/providers/openai.png';
import xaiIcon from './assets/providers/xai.png';
import kimiIcon from './assets/providers/kimi.png';
import { providerKindOf } from './lib/provider.js';

const PROVIDERS = {
  claude: { label: 'Anthropic Claude', icon: anthropicIcon },
  codex: { label: 'OpenAI Codex', icon: openaiIcon },
  grok: { label: 'xAI Grok', icon: xaiIcon },
  'kimi-k3': { label: 'Moonshot Kimi K3', icon: kimiIcon },
};

function initials(label) {
  const words = String(label || 'AI').trim().split(/\s+/).filter(Boolean);
  return words.slice(0, 2).map((word) => word[0]).join('').toUpperCase() || 'AI';
}

export default function ProviderBadge({ session }) {
  const kind = providerKindOf(session);
  const provider = PROVIDERS[kind];
  const label = provider?.label || session?.agentLabel || (kind === 'shell' ? 'Shell' : kind);
  const source = session?.originLabel ? `; started from ${session.originLabel}` : '';
  const accessibleLabel = `${label}${source}`;

  return (
    <span className={`cc-provider cc-provider-${kind}`} title={accessibleLabel} aria-label={accessibleLabel}>
      {provider?.icon ? (
        <img src={provider.icon} alt="" aria-hidden="true" />
      ) : (
        <span className="cc-provider-fallback" aria-hidden="true">
          {kind === 'shell' ? '>_' : initials(label)}
        </span>
      )}
    </span>
  );
}
