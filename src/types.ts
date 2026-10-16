export type ChannelId = "samsclub" | "amazon" | "tiktokshop";

export interface ChannelInfo {
  id: ChannelId;
  label: string;
  code: number;
  supportsKeywordSearch: boolean;
  docs: string;
  configured: boolean;
}

/** 统一商品结构，三个渠道都拍平成这个形状 */
export interface Product {
  channel: ChannelId;
  channelKey: string;
  productName: string;
  category: string;
  price: number | null;
  currency: string;
  /**
   * 销量 / 评价数（整数）。
   * 山姆取的是星级右边那个数字（列表页 DOM）或 JSON-LD 的
   * aggregateRating.reviewCount（详情页），本质是「评价数」；
   * 亚马逊 / TikTok 是 ratings / sold。取不到为 null，不要用 0 冒充。
   */
  sales?: number | null;
  imageUrl: string;
  productUrl: string;
  /** 采集时附带的页面描述，仅用于展示参考，不写入数据库 */
  description?: string;
  /** remote = 在线检索；local = 书签/粘贴采集 */
  source?: "remote" | "local";
}

export interface SelectionItem extends Product {
  id: string;
  createdAt: string;
}

export interface SearchResult {
  channel: ChannelId;
  keyword: string;
  items: Product[];
  failed: string[];
  total: number;
  cached: boolean;
}

export interface AddResult {
  added: number;
  total: number;
  submitted: number;
}

/** 书签采集安装信息 */
export interface CollectInfo {
  collectUrl: string;
  defaultChannel: ChannelId;
  bookmarklet: string;
}

/** 一条已采集、待展示的商品 */
export interface CollectedItem {
  id: string;
  receivedAt: string;
  product: Product;
}

export class ApiError extends Error {
  code: string;
  hint: string;
  constructor(message: string, code = "API_ERROR", hint = "") {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}
