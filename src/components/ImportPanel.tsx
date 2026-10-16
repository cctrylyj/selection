import { Alert, Button, Form, Input, Select, Space, Typography, message } from "antd";
import { useState } from "react";
import { FileAddOutlined } from "@ant-design/icons";
import type { ChannelId, CollectedItem } from "../types";
import { api } from "../api";

const CHANNEL_OPTIONS: { value: ChannelId; label: string }[] = [
  { value: "samsclub", label: "1 山姆会员店" },
  { value: "amazon", label: "2 亚马逊" },
  { value: "tiktokshop", label: "3 TikTok Shop" },
];

/** 粘贴导入：适合不想装书签、或需要一次性批量导入的场景 */
export default function ImportPanel({ onImported }: { onImported: (item: CollectedItem) => void }) {
  const [channel, setChannel] = useState<ChannelId>("samsclub");
  const [url, setUrl] = useState("");
  const [html, setHtml] = useState("");
  const [jsonld, setJsonld] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    const u = url.trim();
    const h = html.trim();
    const j = jsonld.trim();
    if (!u && !h && !j) {
      message.warning("请填写商品链接，或粘贴页面 HTML / JSON-LD");
      return;
    }
    setLoading(true);
    try {
      const item = await api.importProduct(
        u ? { channel, url: u } : h ? { channel, html: h } : { channel, jsonld: j }
      );
      message.success(`已导入：${item.product.productName}`);
      onImported(item);
      setUrl("");
      setHtml("");
      setJsonld("");
    } catch (e) {
      message.error((e as Error).message || "导入失败");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="panel-block">
      <Alert
        type="info"
        showIcon
        message="三种粘贴方式，任选其一"
        description={
          <span>
            <b>商品链接</b>：本服务会先过一遍 robots.txt 再去取页面，被反爬的站点会给出明确提示；
            <b>页面 HTML</b>：在商品页按 <Typography.Text keyboard>Ctrl+U</Typography.Text>，全选复制后粘进来；
            <b>JSON-LD</b>：同样在源码里搜 <Typography.Text code>application/ld+json</Typography.Text>，
            复制那一整段 <Typography.Text code>{"{}"}</Typography.Text> 内容。
          </span>
        }
      />

      <Form layout="vertical" style={{ marginTop: 16, maxWidth: 720 }}>
        <Form.Item label="产品渠道" required>
          <Select<ChannelId>
            value={channel}
            style={{ width: 220 }}
            options={CHANNEL_OPTIONS}
            onChange={setChannel}
          />
        </Form.Item>

        <Form.Item label="商品链接">
          <Input
            value={url}
            allowClear
            placeholder="https://www.samsclub.com/ip/…"
            onChange={(e) => setUrl(e.target.value)}
          />
        </Form.Item>

        <Form.Item
          label="页面 HTML"
          extra="适合链接被站点拦截时使用；粘贴源码内容即可，不需要懂格式"
        >
          <Input.TextArea
            value={html}
            rows={4}
            placeholder="<html>…"
            onChange={(e) => setHtml(e.target.value)}
          />
        </Form.Item>

        <Form.Item label="JSON-LD 片段" extra="商品页源码里的结构化数据，字段最干净">
          <Input.TextArea
            value={jsonld}
            rows={4}
            placeholder={'{"@context":"https://schema.org","@type":"Product", …}'}
            onChange={(e) => setJsonld(e.target.value)}
          />
        </Form.Item>

        <Space>
          <Button type="primary" icon={<FileAddOutlined />} loading={loading} onClick={submit}>
            导入并解析
          </Button>
        </Space>
      </Form>
    </div>
  );
}
