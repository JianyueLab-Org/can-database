/**
 * 把一个筛选值挂在地址栏的查询串上。
 *
 * 清单页的筛选（搜索词、FIR、类别）写进 URL，于是「把这一屏发给别人」「后退回到刚才那一
 * 屏」「刷新之后还在原处」三件事不需要任何额外代码。用 `replaceState` 而不是
 * `pushState`：每敲一个字母不该多一条历史记录。
 *
 * **初值在 `onMounted` 里读，不在 setup 里读。** 这些岛屿大多是 `client:load`，服务端先
 * 按默认值渲染一遍 —— setup 里直接读 `location` 会让水合时两边的 DOM 对不上。
 *
 * 值等于默认值时从查询串里删掉，地址栏只留真正设过的筛子。
 */
import { onMounted, ref, watch, type Ref } from "vue";

export function useQueryState(key: string, fallback = ""): Ref<string> {
  const state = ref(fallback);

  onMounted(() => {
    const initial = new URLSearchParams(window.location.search).get(key);
    if (initial !== null) state.value = initial;

    watch(state, (value) => {
      const url = new URL(window.location.href);
      if (value === fallback || value === "") url.searchParams.delete(key);
      else url.searchParams.set(key, value);
      window.history.replaceState(window.history.state, "", url);
    });
  });

  return state;
}
