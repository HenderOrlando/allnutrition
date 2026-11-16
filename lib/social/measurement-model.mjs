// Pure projections: no storage/provider imports, so every route can load them
// without a cycle through connections, campaigns and background analysis.
export const SOCIAL_BUSINESS_OBJECTIVES = Object.freeze(['reach', 'engagement', 'traffic', 'whatsapp', 'sales']);
export const newSocialMeasurementConfig = () => ({ version: 1, objective: 'reach', source: 'none', pixelId: null, datasetId: null, events: [], externalDescription: '', verification: { status: 'unverified', checkedAt: null, notice: 'No se ha verificado una fuente de medición.' }, updatedAt: null });

export function socialMeasurementDTO(connection) {
  const current = connection.measurementConfig || newSocialMeasurementConfig();
  const verification = current.verification || newSocialMeasurementConfig().verification;
  const accountMatches = !verification.accountId || verification.accountId === connection.identities?.adAccountId;
  const authorizationMatches = verification.status !== 'verified' || verification.sessionEpoch === (connection.sessionEpoch || 0) && verification.configurationFingerprint === connection.configurationFingerprint;
  const verified = connection.state === 'connected' && !connection.revalidationRequired && accountMatches && authorizationMatches;
  return { ...current, verification: verified ? verification : { status: 'unverified', checkedAt: verification.checkedAt || null, notice: 'La cuenta o su autorización cambió. Vuelve a comprobar la medición.' } };
}
