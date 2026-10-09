// ブランドの紹介（ストアの「ブランドから探す」）。商品の brand と同じ名前で引く。ブランド名・紹介文はすべて架空。
// 管理画面で新しいブランド名の商品を登録した場合は、名前だけを表示する（tone は一覧の丸い印の色）。
export const BRANDS = {
  'SENA PROFESSIONAL': { kana: 'セナ プロフェッショナル', lead: 'サロンの仕上がりを、毎日のケアに。', tone: 1 },
  'SENA BOTANICAL': { kana: 'セナ ボタニカル', lead: '植物のちからで、やわらかな髪へ。', tone: 2 },
  'MIZUHA': { kana: 'みずは', lead: '和の植物とうるおいのヘアケア。', tone: 3 },
  'CALMÉ SCALP': { kana: 'カルメ スカルプ', lead: '髪の土台を、頭皮から整える。', tone: 4 },
  'NOIR ATELIER': { kana: 'ノワール アトリエ', lead: '質感をつくる、サロンのスタイリング。', tone: 5 },
  'HARU ORGANICS': { kana: 'ハル オーガニクス', lead: 'やさしい洗い心地と、植物の香り。', tone: 6 },
  'IRODORI COLOR': { kana: 'いろどり カラー', lead: 'ヘアカラーを、長く楽しむ。', tone: 7 },
};
export const brandInfo = name => BRANDS[name] || { kana: '', lead: '', tone: 0 };
