// A small stand-in for a real trip snapshot. Not the family's actual data —
// just enough shape to drive the UI: three days, a stay, stops with Korean
// names and coordinates, and one note sitting between two stops.
//
// This lives in the repo rather than a scratch directory because a container
// recycle once took the whole suite with it.
const snap = {
  meta: {
    title: "首爾秋楓銀杏行",
    destinationLocal: "서울",
    eyebrow: "10.23 — 10.25 · 2026",
    dateStart: "2026-10-23",
    dateEnd: "2026-10-25",
    lat: 37.5665, lng: 126.9780,
    facts: ["3 日行程", "7 位", "秋天"],
    hotelTags: ["近地鐵", "有升降機", "雙人房 x3"],
  },
  stays: [{
    name: "明洞 L7 酒店",
    desc: "近地鐵 4 號線明洞站，行 3 分鐘。",
    from: "day1", to: "day3",
    lat: 37.5636, lng: 126.9827,
  }],
  accessLegend: ["平路為主", "有斜路同石級", "好多樓梯"],
  weatherRows: [
    { date: "10-23", hi: "19°", lo: "9°", note: "晴" },
    { date: "10-24", hi: "18°", lo: "8°", note: "多雲" },
  ],
  clothing: [{ icon: "", html: "早晚溫差大，帶多件外套。" }],
  foliageNote: "10 月下旬銀杏開始轉黃。",
  transitInfo: {
    intro: "7 個人喺首爾點畀車錢，一次過講清楚。",
    verdict: "每人買一張 T-money 就夠。",
    cards: [
      { name:"T-money 卡", kr:"티머니", price:"卡 ₩3,000–5,000／人", good:"地鐵、巴士、的士都用得。", bad:"冇折扣優惠。", pick:true },
      { name:"氣候同行卡", kr:"기후동행카드", price:"1 日 ₩5,000", good:"市內任搭。", bad:"出咗首爾用唔到。" },
    ],
    fares: [{ what:"地鐵基本", cost:"₩1,550", note:"" }],
    tips: ["T-money 喺便利店買得到。"],
    asOf: "車費為 2026 年資料。",
  },
  days: [
    {
      id: "day1", date: "10月23日（五）", title: "抵達・明洞落腳",
      items: [
        stop("仁川機場 T1", "인천공항 1터미널", "p1", 37.4492, 126.4506),
        conn("機場快線約 60 分鐘"),
        stop("明洞酒店 Check-in", "명동", "p2", 37.5636, 126.9827),
        stop("明洞餃子", "명동교자", "p3", 37.5634, 126.9850),
      ],
    },
    {
      id: "day2", date: "10月24日（六）", title: "古宮・北村・南山夜景",
      items: [
        stop("景福宮", "경복궁", "p4", 37.5796, 126.9770),
        { kind: "note", text: "由景福宮行去北村，順路可以經三清洞食個下午茶。" },
        stop("北村韓屋村", "북촌한옥마을", "p5", 37.5826, 126.9834),
        stop("南山塔 韓牛燒肉", "한우 구이", "p6", 37.5512, 126.9882),
      ],
    },
    {
      id: "day3", date: "10月25日（日）", title: "聖水洞・咖啡一日",
      items: [],
    },
  ],
};

function stop(title, kr, placeId, lat, lng){
  return { kind: "stop", title, kr, placeId, lat, lng,
           mapUrl: "https://maps.google.com", type: "sight" };
}
function conn(text){
  return { kind: "connector", mode: "metro", text,
           html: `<span class="icon"></span>${text}` };
}

module.exports = { snap };
