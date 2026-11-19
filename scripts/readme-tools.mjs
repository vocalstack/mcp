export function toolLines(tools) {
  return tools.map((t) => {
    const first = t.description.split("\n")[0].trim();
    return `- \`${t.name}\`: ${(first.match(/^.*?[.!?](?=\s|$)/) ?? [first])[0]}`;
  });
}

export function withTools(readme, tools) {
  return readme.replace(/(<!-- tools -->\n)[\s\S]*?(\n<!-- \/tools -->)/, `$1${toolLines(tools).join("\n")}$2`);
}
