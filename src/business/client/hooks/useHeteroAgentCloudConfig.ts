import { isDesktop } from '@lobechat/const';
import { useParams } from 'react-router-dom';
import urlJoin from 'url-join';

import { useQueryRoute } from '@/hooks/useQueryRoute';
import { lambdaQuery } from '@/libs/trpc/client';
import { useAgentStore } from '@/store/agent';
import { agentSelectors } from '@/store/agent/selectors';
import { useServerConfigStore } from '@/store/serverConfig';

// Fixed cred key — must stay in sync with CloudHeterogeneousConfig
const CLAUDE_TOKEN_CRED_KEY = 'CLAUDE_CODE_OAUTH_TOKEN';

interface HeteroAgentCloudConfig {
  goToConfig: () => void;
  isConfigured: boolean;
}

export const useHeteroAgentCloudConfig = (): HeteroAgentCloudConfig => {
  const params = useParams<{ aid: string }>();
  const router = useQueryRoute();

  const heterogeneousProvider = useAgentStore(
    (s) => agentSelectors.currentAgentConfig(s)?.agencyConfig?.heterogeneousProvider,
  );

  // Only claude-code agents require a cloud credential — codex and other providers do not use this key.
  // In self-hosted SSE mode, agents are dispatched to the user's desktop via device-gateway,
  // so the desktop's local CLI credentials are used — no cloud token needed.
  const isClaudeCode = heterogeneousProvider?.type === 'claude-code';
  const isSseMode = useServerConfigStore((s) => s.serverConfig?.agentGatewayMode === 'sse');
  const needsCredCheck = !isDesktop && !isSseMode && isClaudeCode;

  // Only fetch credentials when actually needed
  const { data: credsData, isLoading: isCredsLoading } = lambdaQuery.market.creds.list.useQuery(
    undefined,
    { enabled: needsCredCheck },
  );

  // isConfigured is true when:
  // 1. Running on desktop (local execution, no cloud creds needed), or
  // 2. No heterogeneous provider on this agent, or
  // 3. Provider is not claude-code (e.g. codex — no cloud credential required), or
  // 4. The agent env has a CLAUDE_CODE_CRED_KEY reference set, or
  // 5. The CLAUDE_CODE_OAUTH_TOKEN credential actually exists in the vault
  //    (handles the case where the credential was saved but the env ref wasn't written)
  // 6. Credentials are still loading — treat as configured to avoid a flash of the
  //    "not configured" alert that immediately disappears once the query resolves
  const hasCredInVault = (credsData?.data ?? []).some((c) => c.key === CLAUDE_TOKEN_CRED_KEY);
  const isConfigured =
    !needsCredCheck ||
    !!heterogeneousProvider?.env?.CLAUDE_CODE_CRED_KEY ||
    hasCredInVault ||
    isCredsLoading;

  const goToConfig = () => {
    const agentId = params.aid;
    if (agentId) {
      router.push(urlJoin('/agent', agentId, 'profile'));
    }
  };

  return { goToConfig, isConfigured };
};
