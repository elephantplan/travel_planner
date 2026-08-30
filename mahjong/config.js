// Supabase 連線設定。publishable key 係設計上公開嘅，寫入一律要 host key + RLS 保護。
export const SUPABASE_URL = 'https://fhmrktvyekrbbhgpipvv.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_TWU02IV_Edv7yYwLBtMIzw_ivczz3Zf';

// 玩法預設：番數 -> 金額
export const PRESETS = [
  {
    id: 'chicken25', name: '25 雞', desc: '起糊 $25，常見大枱',
    minFan: 3, maxFan: 10, payMode: 'half',
    table: { 3: 25, 4: 50, 5: 100, 6: 150, 7: 200, 8: 250, 9: 300, 10: 400 },
  },
  {
    id: 'dollar12', name: '12 蚊', desc: '起糊 $12，細注輕鬆玩',
    minFan: 3, maxFan: 10, payMode: 'half',
    table: { 3: 12, 4: 24, 5: 48, 6: 72, 7: 96, 8: 120, 9: 144, 10: 192 },
  },
  {
    id: 'chicken5', name: '5 雞', desc: '起糊 $5，新手友善',
    minFan: 3, maxFan: 10, payMode: 'half',
    table: { 3: 5, 4: 10, 5: 20, 6: 30, 7: 40, 8: 50, 9: 60, 10: 80 },
  },
];

// 番種（勾選自動加總）。excludes = 勾咗呢個就取消嗰啲；limit = 直接封頂番
export const FAN_TYPES = [
  { id: 'ping', name: '平胡', fan: 1 },
  { id: 'menqian', name: '門前清', fan: 1 },
  { id: 'zimo', name: '自摸', fan: 1 },
  { id: 'nohua', name: '無花', fan: 1 },
  { id: 'duidui', name: '對對胡', fan: 3 },
  { id: 'hunyi', name: '混一色', fan: 3 },
  { id: 'qingyi', name: '清一色', fan: 7, excludes: ['hunyi'] },
  { id: 'xiaosan', name: '小三元', fan: 5 },
  { id: 'dasan', name: '大三元', fan: 8, excludes: ['xiaosan'] },
  { id: 'xiaosi', name: '小四喜', fan: 13, limit: true },
  { id: 'dasi', name: '大四喜', fan: 13, limit: true, excludes: ['xiaosi'] },
  { id: 'ziyi', name: '字一色', fan: 10, limit: true },
  { id: 'gang', name: '槓上開花', fan: 1 },
  { id: 'haidi', name: '海底撈月', fan: 1 },
  { id: 'qianggang', name: '搶槓', fan: 1 },
  { id: 'shisanyao', name: '十三么', fan: 13, limit: true },
  { id: 'jiulian', name: '九蓮寶燈', fan: 10, limit: true },
  { id: 'kankan', name: '坎坎胡', fan: 8 },
];

export const SEAT_WINDS = ['東', '南', '西', '北'];
