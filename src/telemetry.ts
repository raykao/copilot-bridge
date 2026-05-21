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
  process.on('SIGTERM', () => { void sdk.shutdown(); });
  process.on('SIGINT', () => { void sdk.shutdown(); });
}
