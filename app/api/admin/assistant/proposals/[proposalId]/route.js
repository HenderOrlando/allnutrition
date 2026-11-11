import { getAssistantProposalHTTP, postAssistantProposalHTTP } from '@/lib/assistant/proposal-http.mjs';

export const runtime = 'nodejs';
export const GET = getAssistantProposalHTTP;
export const POST = postAssistantProposalHTTP;
