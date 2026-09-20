"""Compact client-style tool definitions and bounded, pure local tool handlers."""
from __future__ import annotations

import ast
import copy
from fractions import Fraction
import json
import math
from pathlib import Path

REQUEST_DEFAULTS = {"tool_mode": "client", "max_tokens": 128}
TOOL_MODES = ("client", "compatible", "off")
MAX_TOOL_ROUNDS = 1
MAX_CALLS_PER_ROUND = 4
INSTRUCTIONS = "解答当前短逻辑题。优先直接推算，只答结论；必要时补一句短依据。"
DECLARATIONS = """namespace functions {
  // 核算数值表达式
  type calculate = (_: {expression: string}) => {result: string};
  // 统计不重叠出现次数
  type count_occurrences = (_: {text: string, target: string}) => {count: number};
}"""
FUNCTIONS = [
    {"type": "function", "name": "calculate", "description": "仅必要时核算。支持数字、四则、整除、余数、幂和括号。",
     "parameters": {"type": "object", "properties": {"expression": {"type": "string"}},
                    "required": ["expression"], "additionalProperties": False}, "strict": True},
    {"type": "function", "name": "count_occurrences", "description": "统计文本中目标串不重叠出现的次数。",
     "parameters": {"type": "object", "properties": {"text": {"type": "string"}, "target": {"type": "string"}},
                    "required": ["text", "target"], "additionalProperties": False}, "strict": True},
]


def load_questions(path: Path) -> list[dict]:
    try:
        rows = json.loads(path.read_text(encoding="utf-8-sig"))["items"]
        if not isinstance(rows, list) or not 1 <= len(rows) <= 2000:
            raise ValueError("题库数量无效")
        for row in rows:
            if not isinstance(row, dict) or any(not isinstance(row.get(key), str) or not row[key].strip()
                                                for key in ("id", "category", "question", "answer")):
                raise ValueError("题库条目无效")
        if len({row["id"] for row in rows}) != len(rows) or len({row["question"] for row in rows}) != len(rows):
            raise ValueError("题库编号或题目重复")
        return rows
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise RuntimeError("无法读取 logic_questions.json，请完整解压安装包或检查题库格式") from exc


def add_client_fields(body: dict, args, prompt: str) -> dict:
    mode = getattr(args, "tool_mode", "client")
    instruction = INSTRUCTIONS
    if mode != "off":
        instruction += "\n确需核算时再调用工具。\n" + DECLARATIONS
        if args.api_style == "chat" or mode == "compatible":
            instruction += "\n兼容接口工具名：functions_calculate、functions_count_occurrences。"
    if args.api_style == "chat":
        body["messages"] = ([{"role": "user", "content": instruction + "\n" + prompt}] if mode == "off" else
                            [{"role": "system", "content": instruction}, {"role": "user", "content": prompt}])
        if mode != "off":
            body["tools"] = [{"type": "function", "function": {
                "name": "functions_" + tool["name"], "description": tool["description"],
                "parameters": copy.deepcopy(tool["parameters"]), "strict": tool["strict"]}} for tool in FUNCTIONS]
    else:
        developer = {"type": "message", "role": "developer",
                     "content": [{"type": "input_text", "text": instruction}]}
        user = {"type": "message", "role": "user", "content": [{"type": "input_text", "text": prompt}]}
        body["input"] = [developer, user]
        body["instructions"] = ""
        body["store"] = False
        if mode == "client":
            body["input"].insert(0, {"type": "additional_tools", "role": "developer", "tools": [
                {"type": "namespace", "name": "functions", "description": "短题的本地核算工具",
                 "tools": copy.deepcopy(FUNCTIONS)}]})
            model = args.model.lower()
            if model.startswith(("gpt-5", "gpt-6")) and "chat" not in model:
                body["reasoning"] = {"effort": "low"}
                body["text"] = {"verbosity": "low"}
        elif mode == "compatible":
            body["tools"] = [{**copy.deepcopy(tool), "name": "functions_" + tool["name"]} for tool in FUNCTIONS]
        else:
            body["input"] = [user]
            body["instructions"] = instruction
    if mode != "off":
        body["tool_choice"] = "auto"
        body["parallel_tool_calls"] = False
    return body


def extract_calls(data: object) -> list[dict]:
    if not isinstance(data, dict):
        return []
    output = data.get("output")
    if isinstance(output, list):
        return [{"call_id": item.get("call_id"), "name": item.get("name"),
                 "namespace": item.get("namespace"), "arguments": item.get("arguments")}
                for item in output if isinstance(item, dict) and item.get("type") == "function_call"]
    choices = data.get("choices")
    if isinstance(choices, list) and choices and isinstance(choices[0], dict):
        message = choices[0].get("message")
        if isinstance(message, dict) and isinstance(message.get("tool_calls"), list):
            calls = []
            for item in message["tool_calls"]:
                function = item.get("function") if isinstance(item, dict) else None
                if isinstance(function, dict):
                    calls.append({"call_id": item.get("id"), "name": function.get("name"),
                                  "namespace": None, "arguments": function.get("arguments")})
            return calls
    return []


def _calculate(expression: str) -> str:
    if not isinstance(expression, str) or not 1 <= len(expression) <= 256:
        raise ValueError("表达式必须是 1–256 字符的字符串")
    tree = ast.parse(expression.replace("×", "*").replace("÷", "/"), mode="eval")
    if sum(1 for _ in ast.walk(tree)) > 80:
        raise ValueError("表达式过长")

    def bounded(value):
        if value.numerator.bit_length() > 256 or value.denominator.bit_length() > 256:
            raise ValueError("数值超过计算范围")
        return value

    def evaluate(node):
        if isinstance(node, ast.Constant) and type(node.value) in (int, float):
            if isinstance(node.value, float) and not math.isfinite(node.value):
                raise ValueError("只支持有限数值")
            return bounded(Fraction(str(node.value)))
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
            value = evaluate(node.operand)
            return value if isinstance(node.op, ast.UAdd) else -value
        if isinstance(node, ast.BinOp):
            left, right = evaluate(node.left), evaluate(node.right)
            if isinstance(node.op, ast.Add):
                value = left + right
            elif isinstance(node.op, ast.Sub):
                value = left - right
            elif isinstance(node.op, ast.Mult):
                value = left * right
            elif isinstance(node.op, ast.Div):
                value = left / right
            elif isinstance(node.op, ast.FloorDiv):
                value = Fraction(left // right)
            elif isinstance(node.op, ast.Mod):
                value = left % right
            elif isinstance(node.op, ast.Pow) and right.denominator == 1 and abs(right.numerator) <= 6:
                value = left ** int(right)
            else:
                raise ValueError("仅支持数值四则、整除、余数与小整数幂")
            return bounded(value)
        raise ValueError("不支持变量、函数、属性或其他代码")

    return str(evaluate(tree.body))


def execute_call(call: dict) -> dict:
    name = call.get("name")
    namespace = call.get("namespace")
    raw = call.get("arguments")
    try:
        if namespace not in (None, "", "functions") or not isinstance(name, str):
            raise ValueError("未知工具命名空间")
        for prefix in ("functions.", "functions_"):
            if name.startswith(prefix):
                name = name[len(prefix):]
                break
        if not isinstance(raw, str) or len(raw) > 16384:
            raise ValueError("工具参数必须是有限长度的 JSON 字符串")
        parameters = json.loads(raw)
        if not isinstance(parameters, dict):
            raise ValueError("工具参数必须是 JSON 对象")
        if name == "calculate" and set(parameters) == {"expression"}:
            return {"result": _calculate(parameters["expression"])}
        if name == "count_occurrences" and set(parameters) == {"text", "target"}:
            text, target = parameters["text"], parameters["target"]
            if not isinstance(text, str) or not isinstance(target, str) or len(text) > 4096 or not 1 <= len(target) <= 512:
                raise ValueError("文本或目标串长度无效")
            return {"count": text.count(target)}
        raise ValueError("未知工具或参数字段不匹配")
    except (ValueError, TypeError, SyntaxError, ZeroDivisionError, OverflowError) as exc:
        return {"error": str(exc)[:240]}


def continue_with_tools(payload: dict, data: dict, style: str, calls: list[dict]) -> tuple[dict, list[dict]]:
    if not 1 <= len(calls) <= MAX_CALLS_PER_ROUND:
        raise ValueError("工具调用数量超过单轮上限")
    ids = [call.get("call_id") for call in calls]
    if any(not isinstance(value, str) or not value or len(value) > 64 for value in ids) or len(set(ids)) != len(ids):
        raise ValueError("工具调用 ID 缺失或重复")
    if any(not isinstance(call.get("arguments"), str) or len(call["arguments"]) > 16384 for call in calls):
        raise ValueError("工具参数缺失或过长")
    traces = [{**call, "output": execute_call(call)} for call in calls]
    for call in traces:
        name = str(call.get("name") or "unknown")
        for prefix in ("functions.", "functions_"):
            if name.startswith(prefix):
                name = name[len(prefix):]
                break
        call["qualified_name"] = f"{call.get('namespace') or 'functions'}.{name}"
    following = copy.deepcopy(payload)
    if style == "responses":
        following["input"].extend(copy.deepcopy(data.get("output", [])))
        following["input"].extend({"type": "function_call_output", "call_id": call["call_id"],
                                   "output": json.dumps(call["output"], ensure_ascii=False, separators=(",", ":"))}
                                  for call in traces)
    else:
        message = data["choices"][0]["message"]
        following["messages"].append({"role": "assistant", "content": message.get("content"),
                                      "tool_calls": copy.deepcopy(message["tool_calls"])})
        following["messages"].extend({"role": "tool", "tool_call_id": call["call_id"],
                                      "content": json.dumps(call["output"], ensure_ascii=False, separators=(",", ":"))}
                                     for call in traces)
    # One tool round is enough for this short-question client.
    following["tool_choice"] = "none"
    return following, traces


def sum_usage(previous, current):
    if not isinstance(current, dict):
        return previous
    merged = dict(previous) if isinstance(previous, dict) else {}
    for key, value in current.items():
        if isinstance(value, dict):
            merged[key] = sum_usage(merged.get(key), value)
        elif type(value) in (int, float) and math.isfinite(value):
            merged[key] = (merged.get(key, 0) if type(merged.get(key, 0)) in (int, float) else 0) + value
    return merged or previous
