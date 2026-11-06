# 第三方声明

本项目自身代码以 [MIT](LICENSE) 授权。以下内容来自第三方，各自遵循原项目的许可。

## 供应商预设目录

`src/presets.json` 中的厂商 / 中转 / 本机预设条目，由 `scripts/gen-presets.mjs`
从 [magpie](https://github.com/yetone/magpie) 的 `internal/provider/presets.go`
及其合作伙伴列表整理而来。

```
MIT License

Copyright (c) yetone and magpie contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

预设条目只包含厂商公开的接入信息（名称、Base URL、图标标识、官网与密钥页地址），
不含任何密钥或私有数据。

## 模型能力数据

模型上下文窗口、最大输出、是否支持思考 / 图片等能力信息，运行时从以下来源获取，不随本仓库分发：

- 供应商自己的 `/models` 接口（各厂商公开 API）
- [models.dev](https://models.dev) 的公开目录（缓存到本地 `~/.config/agent-session-recap/models-dev.json`）
