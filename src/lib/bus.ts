/** 极简事件总线：产品信息页加入选品后，通知选品页与菜单角标刷新 */

type Handler = () => void;
const handlers = new Set<Handler>();

export const selectionBus = {
  emit() {
    for (const h of handlers) h();
  },
  subscribe(handler: Handler) {
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
    };
  },
};
