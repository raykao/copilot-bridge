import { trace, propagation, context as otelContext, SpanStatusCode } from '@opentelemetry/api';

export { trace, propagation, otelContext, SpanStatusCode };

export function getTracer() {
  return trace.getTracer('copilot-bridge');
}

/**
 * Initializes the OTel SDK. Only loads the SDK when OTEL_EXPORTER_OTLP_ENDPOINT is set.
 * No-op (zero runtime overhead) otherwise.
 */
export async function initTelemetry(): Promise<void> {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return;

  const [{ NodeSDK }, { OTLPTraceExporter }, { Resource }] = await Promise.all([
    import('@opentelemetry/sdk-node'),
    import('@opentelemetry/exporter-trace-otlp-http'),
    import('@opentelemetry/resources'),
  ]);

  const sdk = new NodeSDK({
    resource: new Resource({ 'service.name': process.env.OTEL_SERVICE_NAME ?? 'copilot-bridge' }),
    traceExporter: new OTLPTraceExporter(),
  });

  sdk.start();
  // Shutdown with a 5-second timeout so a missing/unreachable collector cannot
  // delay process exit. The SDK default is 30 seconds which is too long.
  const shutdownWithTimeout = (): void => {
    void Promise.race([
      sdk.shutdown(),
      new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    ]);
  };
  process.on('SIGTERM', shutdownWithTimeout);
  process.on('SIGINT', shutdownWithTimeout);
}
