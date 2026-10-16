import { Badge, Empty, Layout, Menu } from "antd";
import { useEffect, useState } from "react";
import { Link, Navigate, Route, Routes, useLocation } from "react-router-dom";

import ProductsPage from "./pages/ProductsPage";
import SelectionPage from "./pages/SelectionPage";
import { api } from "./api";
import { selectionBus } from "./lib/bus";

const { Sider, Header, Content } = Layout;

const MENU_ITEMS = [
  { key: "/products", label: <Link to="/products">产品信息</Link> },
  { key: "/selection", label: <Link to="/selection">选品</Link> },
];

export default function App() {
  const location = useLocation();
  const [count, setCount] = useState(0);

  useEffect(() => {
    const refresh = () => {
      api
        .listSelections()
        .then((res) => setCount(res.total))
        .catch(() => setCount(0));
    };
    refresh();
    return selectionBus.subscribe(refresh);
  }, []);

  const items = MENU_ITEMS.map((item) =>
    item.key === "/selection"
      ? {
          ...item,
          label: (
            <span className="menu-selection">
              选品
              {count > 0 ? (
                <Badge
                  count={count}
                  size="small"
                  offset={[8, -8]}
                  style={{ backgroundColor: "#1677ff" }}
                />
              ) : null}
            </span>
          ),
        }
      : item
  );

  return (
    <Layout className="app-shell">
      <Sider width={216} theme="light" breakpoint="lg" collapsible>
        <div className="brand">选品系统</div>
        <Menu
          mode="inline"
          selectedKeys={[location.pathname]}
          items={items}
          style={{ borderInlineEnd: "none" }}
        />
      </Sider>

      <Layout>
        <Header className="app-header">
          <span className="app-title">多渠道商品选品工作台</span>
          <span className="app-subtitle">山姆 · 亚马逊 · TikTok Shop ｜ 选品数据存 Supabase</span>
        </Header>

        <Content className="app-content">
          <Routes>
            <Route path="/" element={<Navigate to="/products" replace />} />
            <Route path="/products" element={<ProductsPage />} />
            <Route path="/selection" element={<SelectionPage />} />
            <Route
              path="*"
              element={
                <Empty
                  description="页面不存在"
                  style={{ padding: 80 }}
                />
              }
            />
          </Routes>
        </Content>
      </Layout>
    </Layout>
  );
}
