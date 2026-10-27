/** Compatibility exports; the Pi-backed model runtime now lives in the model layer. */
export {
  completePiModel,
  createPiGatewayRuntime,
  PiGatewayRuntime,
  resolveGatewayModel,
  streamPiModel,
} from '../models/piRuntime.ts'
export type { AssistantMessage, AssistantMessageEvent, Context, Model } from '@earendil-works/pi-ai'
