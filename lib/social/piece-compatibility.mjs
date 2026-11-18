export function unsupportedSocialDisclosure({ method, mode, platforms, assetKind, disclosure }) {
  return method === 'api' && disclosure === true && (mode === 'paid' || assetKind === 'image' && platforms.includes('facebook'));
}

export function socialPlacementMatches(placement, assetKind, mode) {
  return assetKind === 'image' ? placement.endsWith('_feed') : assetKind !== 'video' || mode !== 'organic' || placement.endsWith('_reels');
}
