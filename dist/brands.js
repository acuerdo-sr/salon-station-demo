// ブランドの紹介（ストアの「ブランドから探す」）。商品の brand と同じ名前で引く。ブランド名・紹介文はすべて架空。
// 管理画面で新しいブランド名の商品を登録した場合は、名前だけを表示する（tone は絵がないときの色）。
// image はブランドのカード（16:9）、hero はブランドで絞った商品一覧の上の大きな絵（8:3、左に紹介文を重ねる）。
export const BRANDS = {
  'SENA PROFESSIONAL': { kana: 'セナ プロフェッショナル', lead: 'サロンの仕上がりを、毎日のケアに。', tone: 1, image: 'brands/sena-professional.svg', hero: 'brands/sena-professional-wide.svg' },
  'SENA BOTANICAL': { kana: 'セナ ボタニカル', lead: '植物のちからで、やわらかな髪へ。', tone: 2, image: 'brands/sena-botanical.svg', hero: 'brands/sena-botanical-wide.svg' },
  'MIZUHA': { kana: 'みずは', lead: '和の植物とうるおいのヘアケア。', tone: 3, image: 'brands/mizuha.svg', hero: 'brands/mizuha-wide.svg' },
  'CALMÉ SCALP': { kana: 'カルメ スカルプ', lead: '髪の土台を、頭皮から整える。', tone: 4, image: 'brands/calme-scalp.svg', hero: 'brands/calme-scalp-wide.svg' },
  'NOIR ATELIER': { kana: 'ノワール アトリエ', lead: '質感をつくる、サロンのスタイリング。', tone: 5, image: 'brands/noir-atelier.svg', hero: 'brands/noir-atelier-wide.svg' },
  'HARU ORGANICS': { kana: 'ハル オーガニクス', lead: 'やさしい洗い心地と、植物の香り。', tone: 6, image: 'brands/haru-organics.svg', hero: 'brands/haru-organics-wide.svg' },
  'IRODORI COLOR': { kana: 'いろどり カラー', lead: 'ヘアカラーを、長く楽しむ。', tone: 7, image: 'brands/irodori-color.svg', hero: 'brands/irodori-color-wide.svg' },
};
export const brandInfo = name => BRANDS[name] || { kana: '', lead: '', tone: 0, image: '', hero: '' };
// ホームの「おすすめ」（3つまで）。押すとその商品のページへ。絵は scripts/generate-product-art.mjs で作る
export const FEATURES = [
  { id: 'camellia', product: 'mizuha-camellia-oil', title: '椿のつやを、毛先まで。', lead: 'MIZUHA 椿 ヘアオイル', image: 'features/camellia.svg' },
  { id: 'scalp', product: 'calme-scalp-serum', title: '髪の土台を、頭皮から。', lead: 'CALMÉ SCALP スカルプセラム', image: 'features/scalp.svg' },
  { id: 'texture', product: 'noir-balm', title: '質感で、仕上げる。', lead: 'NOIR ATELIER スタイリングバーム', image: 'features/texture.svg' },
];
