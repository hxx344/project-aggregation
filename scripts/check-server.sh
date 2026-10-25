#!/bin/bash
# 一键诊断工作台服务状态

echo "========== 1. 服务运行状态 =========="
systemctl status project-aggregation project-aggregation-api --no-pager 2>/dev/null || echo "至少一个服务未在运行或未安装（见上方状态）"
ps aux | grep -E '[n]ode.*server' | head -5

echo -e "\n========== 2. 端口监听状态 =========="
ss -tlnp 2>/dev/null | grep 3100 || netstat -tlnp 2>/dev/null | grep 3100 || echo "3100 端口未监听"

echo -e "\n========== 3. 最近 20 行日志（运行时与 API） =========="
journalctl -u project-aggregation -u project-aggregation-api -n 20 --no-pager 2>/dev/null || echo "无 systemd 日志"

echo -e "\n========== 4. 防火墙状态 =========="
ufw status 2>/dev/null | grep 3100 || iptables -L INPUT -n 2>/dev/null | grep 3100 || echo "防火墙检查需要 root"

echo -e "\n========== 5. Nginx 配置 =========="
nginx -t 2>&1 | head -3 || echo "未安装 Nginx"

echo -e "\n========== 诊断完成 =========="
echo "把上面的输出发给我，或者直接运行修复命令："
echo "sudo systemctl restart project-aggregation"
