import type { RuntimeConnection } from './runtime-service/lifecycle.ts'
import { stopRuntimeService } from './runtime-service/lifecycle.ts'
import { stopTransientGatewayDaemon } from './lifecycle.ts'

export interface InteractiveShutdownDependencies {
  stopRuntime: typeof stopRuntimeService
  stopGateway: typeof stopTransientGatewayDaemon
}

const defaultDependencies: InteractiveShutdownDependencies = {
  stopRuntime: stopRuntimeService,
  stopGateway: stopTransientGatewayDaemon,
}

/** Gracefully stop the background services owned by an interactive TUI session. */
export async function shutdownInteractiveDaemons(
  connection: RuntimeConnection,
  sessionId: string,
  dependencies: InteractiveShutdownDependencies = defaultDependencies,
): Promise<void> {
  await connection.client.sendCommand(
    sessionId,
    'abort',
    {},
    undefined,
    AbortSignal.timeout(1500),
  ).catch(() => undefined)

  const failures: unknown[] = []
  try {
    await dependencies.stopRuntime(connection)
  } catch (error) {
    failures.push(error)
  }
  try {
    await dependencies.stopGateway()
  } catch (error) {
    failures.push(error)
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'One or more interactive background services did not stop cleanly.')
  }
}
