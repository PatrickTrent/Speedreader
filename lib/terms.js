/** Algemene voorwaarden. The modal and /voorwaarden both render this list. */
export const TERMS_BODY = [
  '1. Diensten: Trentelman AI Solutions levert een AI-gestuurde snellees-interface.',
  '2. Credits: Credits zijn eenmalige aankopen en geven recht op één AI-summarization sessie per credit.',
  '3. Gebruik: De gebruiker is verantwoordelijk voor de inhoud die wordt geüpload.',
  "4. Garantie: De software wordt geleverd 'as-is'. Gezien de aard van AI is er geen garantie op 100% foutloosheid.",
  '5. Restitutie: Na levering van digitale credits is herroepingsrecht niet van toepassing.',
  '6. Contact: speedreader@agentmail.to',
];

export function termsMarkup() {
  return TERMS_BODY.map((line) => `<p class="text-slate-300 text-sm md:text-base leading-relaxed">${line}</p>`).join('\n');
}
