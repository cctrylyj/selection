import { Alert, Button, Select, Space, Typography, message } from "antd";
import { useEffect, useState } from "react";
import { CopyOutlined, PushpinOutlined } from "@ant-design/icons";
import type { ChannelId } from "../types";
import type { CollectInfo } from "../types";
import { api } from "../api";

const { Paragraph, Text } = Typography;

const CHANNEL_OPTIONS: { value: ChannelId; label: string }[] = [
  { value: "samsclub", label: "1 山姆会员店" },
  { value: "amazon", label: "2 亚马逊" },
  { value: "tiktokshop", label: "3 TikTok Shop" },
];

/**
 * 零凭证采集：把书签按钮拖到浏览器书签栏，之后在商品页点一下即可。
 * 全程不经过任何第三方服务，也不需要联盟/开发者账号。
 */
export default function BookmarkletPanel() {
  const [defaultChannel, setDefaultChannel] = useState<ChannelId>("samsclub");
  const [info, setInfo] = useState<CollectInfo | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async (ch: ChannelId) => {
    setLoading(true);
    try {
      setInfo(await api.collectInfo(ch));
    } catch (e) {
      message.error((e as Error).message || "获取书签失败，请确认后端已启动");
      setInfo(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(defaultChannel);
    // 仅在挂载时取一次；切换渠道由 Select 的 onChange 触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const copy = async () => {
    if (!info) return;
    try {
      await navigator.clipboard.writeText(info.bookmarklet);
      message.success("书签代码已复制：在书签栏右键 → 添加网页 → 网址粘贴这段代码");
    } catch {
      // 剪贴板 API 在非安全上下文会失败，退回手动复制
      message.warning("浏览器拒绝了自动复制，请手动选中下方代码复制");
    }
  };

  return (
    <div className="panel-block">
      <Alert
        type="success"
        showIcon
        closable
        message="零凭证方案：用你自己的浏览器当采集器"
        description={
          <span>
            不需要数据服务商、不需要代理、不需要亚马逊联盟或 TikTok 开发者账号。
            请求全部来自你自己的浏览器——你本来就在正常浏览页面，不触发任何反爬，也不用登录凭证。
          </span>
        }
      />

      <div className="steps">
        <div className="step">
          <div className="step-no">1</div>
          <div className="step-body">
            <div className="step-title">选择默认渠道（仅用于自动识别失败时兜底）</div>
            <Select<ChannelId>
              value={defaultChannel}
              style={{ width: 220, marginTop: 8 }}
              options={CHANNEL_OPTIONS}
              onChange={(v) => {
                setDefaultChannel(v);
                void load(v);
              }}
            />
          </div>
        </div>

        <div className="step">
          <div className="step-no">2</div>
          <div className="step-body">
            <div className="step-title">装采集器（二选一，推荐左边）</div>
            <Space wrap style={{ marginTop: 8 }}>
              {/* 注意：必须带 /api 前缀——后端路由挂在 /api/products 下。
                   Vite 开发态会把 /api 代理到 8787，生产态同端口，所以用相对路径最稳。 */}
              <a
                className="collector-download"
                href={`/api/products/collector-script?channel=${defaultChannel}`}
                download="sourcing-collector.user.js"
              >
                <PushpinOutlined /> 下载采集脚本（.user.js）
              </a>
              <Button icon={<CopyOutlined />} onClick={copy} loading={loading}>
                复制书签代码
              </Button>
              <a
                className="bookmarklet-btn"
                href={info?.bookmarklet || "javascript:void(0)"}
                onClick={(e) => {
                  e.preventDefault();
                  message.info("拖拽法在新版浏览器里常失效，装不动就用左边的脚本文件");
                }}
              >
                <PushpinOutlined /> 拖到书签栏
              </a>
            </Space>
            <Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0, fontSize: 12 }}>
              <b>方式一（推荐，最稳）</b>：先装 Tampermonkey 扩展（Edge / Chrome 应用商店搜
              “Tampermonkey”），然后把下载到的 <Text code>.user.js</Text> 文件直接拖进浏览器窗口，
              页面弹出安装页点「安装」。
              <Text type="danger" strong>装完（或更新完）一定要刷新一下商品页（F5）</Text>
              ——扩展只会对安装之后加载的页面生效，已经开着的标签页不刷新是不会出现按钮的。
              <br />
              <b>方式二（不装扩展）</b>：把书签栏显示出来（<Text keyboard>Ctrl+Shift+B</Text>），
              点「复制书签代码」，再到书签管理器（<Text keyboard>Ctrl+Shift+O</Text>）→ 添加新网页 →
              名称随意、网址粘贴那段代码。注意：山姆等站点会拦截 javascript: 书签，方式二失效时用方式一。
              <br />
              <b>装过旧版想更新</b>：重新点上面的「下载采集脚本」，拖进浏览器会提示覆盖，点「重新安装」即可；
              也可以打开 Tampermonkey 面板 → 找到「选品系统采集器」→ 点「检查更新」。
              <br />
              <Text type="warning" strong>1.2.0 新增「销量」采集</Text>
              ——列表页会连星级右边那个数字（<Text code>★★★★★ 6754</Text>）一起采下来，
              详情页取 JSON-LD 里的评价数；表格新增「销量」列，并支持点表头排序。
              <br />
              <Text type="warning" strong>1.1.3 修好了价格读错的问题</Text>
              ——山姆把价格拆成「大字整数 + 小字角分」两个节点渲染（<Text code>$16.87</Text> 会读成
              <Text code>$1687</Text>），旧版脚本采到的价格是错的。
              <b>请务必覆盖安装到 1.2.0 并刷新页面</b>，否则价格和销量都会缺。
            </Paragraph>
          </div>
        </div>

        <div className="step">
          <div className="step-no">3</div>
          <div className="step-body">
            <div className="step-title">打开商品页或列表页，点右下角按钮</div>
            <Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0, fontSize: 12 }}>
              山姆、亚马逊、TikTok Shop 都能用。装好后页面<b>右下角</b>会出现蓝色按钮
              「采集到选品系统」（页面是单页应用、切来切去按钮也不会丢）。<b>商品详情页</b>采集单个；
              <b>搜索结果页 / 类目页</b>（如 samsclub.com/search?q=flowers）会一次采集整页商品，最多 60 个。
              点完右上角出现绿色提示，商品随即出现在下方表格里。价格按<b>采集到的币种</b>把金额符号
              跟在数字后面（美元 <Text code>24.98$</Text>、人民币 <Text code>199.00¥</Text>），
              该列为采集原值、<b>不可修改</b>；页面确实没暴露价格时显示「—」。
              销量取页面上的评价数 / 销量数字，取不到也显示「—」。
              <br />
              按钮万一被页面样式挡住，按 <Text keyboard>Ctrl+Shift+Z</Text> 也能采集。
            </Paragraph>
          </div>
        </div>

        <div className="step">
          <div className="step-no">?</div>
          <div className="step-body">
            <div className="step-title">没看到按钮？按这个顺序查</div>
            <Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0, fontSize: 12 }}>
              1. <b>先刷新页面</b>（<Text keyboard>F5</Text>）：脚本只对安装之后加载的页面生效，这是最常见的原因。
              <br />
              2. <Text type="danger" strong>确认浏览器允许运行用户脚本</Text>
              ——<b>这是「装了却没反应」的头号原因</b>。Chrome 138 及以上：打开{" "}
              <Text code>chrome://extensions/</Text> → 找到 Tampermonkey → 点「详情」→
              打开 <Text code>允许用户脚本</Text>（Allow User Scripts）开关。
              Chrome 138 以下：在 <Text code>chrome://extensions/</Text> 右上角打开
              <Text code>开发者模式</Text>。没开这个开关时，脚本能装、能启用、菜单里也列得出来，
              但<b>一行都不会执行</b>，页面上自然什么都没有。
              <br />
              3. 看标签页标题：脚本正常执行时，标题前面会出现
              <Text code>【采集器1.2.0】</Text>。有 → 脚本在跑；没有 → 脚本没被执行，
              回去看第 2 条。
              <br />
              4. 确认 Tampermonkey 面板里「选品系统采集器」是<b>启用</b>状态，版本为{" "}
              <Text code>1.2.0</Text> 或更高。
              <br />
              5. 在商品页按 <Text keyboard>F12</Text> 打开控制台，看有没有
              <Text code>[选品采集器] v1.2.0 已注入</Text> 这行。
              <br />
              <b>应急通路（完全不依赖扩展）</b>：如果上面的开关一时开不了，先点上面的
              「复制书签代码」，再到山姆的商品页按 <Text keyboard>F12</Text> → 切到{" "}
              <Text code>Console</Text> 标签 → 粘贴进去回车，一样能把当前页商品采集进来。
              <br />
              6. 装过旧版（1.0.0）的话，请按上面方式重新下载覆盖安装：旧版没有抗 CSP 与
              抗重渲染的处理，在山姆这类站点上表现就是「装好了但页面什么都没有」。
            </Paragraph>
          </div>
        </div>
      </div>

      <Alert
        type="info"
        showIcon
        message="两点说明"
        description={
          <ul className="tight-list">
            <li>
              采集的商品暂存在后端内存里（重启后清空），<b>勾选加入选品才会落入 Supabase</b>，
              所以看到数据后记得及时加入选品。
            </li>
            <li>
              采集地址为 <Text code>{info?.collectUrl ?? "加载中…"}</Text>，
              换端口部署时重新打开本页即可自动更新。
            </li>
          </ul>
        }
      />
    </div>
  );
}
