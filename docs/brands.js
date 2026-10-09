// ブランドの紹介（ストアの「ブランドから探す」）。商品の brand と同じ名前で引く。ブランド名・紹介文はすべて架空。
// 管理画面で新しいブランド名の商品を登録した場合は、名前だけを表示する（tone は絵がないときの色）。
// image はブランドのカード（16:9）、hero はブランドで絞った商品一覧の上の大きな絵（8:3、左に紹介文を重ねる）。
export const BRANDS = {
  'SENA PROFESSIONAL': { kana: 'セナ プロフェッショナル', lead: 'サロンの仕上がりを、毎日のケアに。', tone: 1, image: 'brands/sena-professional.webp', hero: 'brands/sena-professional-wide.webp' },
  'SENA BOTANICAL': { kana: 'セナ ボタニカル', lead: '植物のちからで、やわらかな髪へ。', tone: 2, image: 'brands/sena-botanical.webp', hero: 'brands/sena-botanical-wide.webp' },
  'MIZUHA': { kana: 'みずは', lead: '和の植物とうるおいのヘアケア。', tone: 3, image: 'brands/mizuha.webp', hero: 'brands/mizuha-wide.webp' },
  'CALMÉ SCALP': { kana: 'カルメ スカルプ', lead: '髪の土台を、頭皮から整える。', tone: 4, image: 'brands/calme-scalp.webp', hero: 'brands/calme-scalp-wide.webp' },
  'NOIR ATELIER': { kana: 'ノワール アトリエ', lead: '質感をつくる、サロンのスタイリング。', tone: 5, image: 'brands/noir-atelier.webp', hero: 'brands/noir-atelier-wide.webp' },
  'HARU ORGANICS': { kana: 'ハル オーガニクス', lead: 'やさしい洗い心地と、植物の香り。', tone: 6, image: 'brands/haru-organics.webp', hero: 'brands/haru-organics-wide.webp' },
  'IRODORI COLOR': { kana: 'いろどり カラー', lead: 'ヘアカラーを、長く楽しむ。', tone: 7, image: 'brands/irodori-color.webp', hero: 'brands/irodori-color-wide.webp' },
};
export const brandInfo = name => BRANDS[name] || { kana: '', lead: '', tone: 0, image: '', hero: '' };
// ホームの「おすすめ」（3つまで）。押すとその商品のページへ。写真は scripts/generate-product-photos.py で作る
export const FEATURES = [
  { id: 'camellia', product: 'mizuha-camellia-oil', title: '椿のつやを、毛先まで。', lead: 'MIZUHA 椿 ヘアオイル', image: 'features/camellia.webp' },
  { id: 'scalp', product: 'calme-scalp-serum', title: '髪の土台を、頭皮から。', lead: 'CALMÉ SCALP スカルプセラム', image: 'features/scalp.webp' },
  { id: 'texture', product: 'noir-balm', title: '質感で、仕上げる。', lead: 'NOIR ATELIER スタイリングバーム', image: 'features/texture.webp' },
];
