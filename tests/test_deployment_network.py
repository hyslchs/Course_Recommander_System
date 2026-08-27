from __future__ import annotations

import os
import shlex
import subprocess
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / "scripts" / "deployment_network.sh"
DEPLOY = ROOT / "deploy.sh"


def _write_executable(path: Path, content: str) -> None:
    path.write_text(content, encoding="utf-8")
    path.chmod(0o755)


def _run_helper(tmp_path: Path, function: str, *, network_output: str | None = None, attached: bool = True):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    fake_docker = bin_dir / "docker"
    network_branch = "" if network_output is None else f"printf '%s\\n' {shlex.quote(network_output)}"
    if network_output is None:
        network_branch = "exit 1"
    attached_output = "printf 'attached\\n'" if attached else "printf '\\n'"
    fake_docker.write_text(
        "#!/usr/bin/env bash\n"
        "if [ \"$1\" = network ]; then\n"
        f"  {network_branch}\n"
        "  exit 0\n"
        "fi\n"
        "if [ \"$1\" = inspect ]; then\n"
        f"  {attached_output}\n"
        "  exit 0\n"
        "fi\n"
        "exit 1\n",
        encoding="utf-8",
    )
    fake_docker.chmod(0o755)
    environment = os.environ.copy()
    environment["PATH"] = f"{bin_dir}{os.pathsep}{environment['PATH']}"
    command = f"source {shlex.quote(str(HELPER))}; {function}"
    return subprocess.run(
        ["bash", "-c", command],
        cwd=ROOT,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )


@pytest.mark.parametrize(
    ("label", "network_output"),
    [
        ("wrong driver", "overlay|172.24.0.0/24|172.24.0.1"),
        ("wrong subnet", "bridge|172.23.0.0/24|172.24.0.1"),
        ("wrong gateway", "bridge|172.24.0.0/24|172.24.0.254"),
    ],
)
def test_fixed_network_preflight_rejects_invalid_networks(tmp_path, label, network_output):
    result = _run_helper(tmp_path, "verify_fixed_network", network_output=network_output)
    assert result.returncode != 0, label


def test_fixed_network_preflight_rejects_missing_network(tmp_path):
    result = _run_helper(tmp_path, "verify_fixed_network")
    assert result.returncode != 0


def test_fixed_network_preflight_accepts_exact_network(tmp_path):
    result = _run_helper(
        tmp_path,
        "verify_fixed_network",
        network_output="bridge|172.24.0.0/24|172.24.0.1",
    )
    assert result.returncode == 0, result.stderr


def test_new_container_must_be_attached_to_fixed_network(tmp_path):
    attached = _run_helper(tmp_path, "verify_container_on_fixed_network container-id")
    assert attached.returncode == 0, attached.stderr

    detached = _run_helper(
        tmp_path,
        "verify_container_on_fixed_network container-id",
        attached=False,
    )
    assert detached.returncode != 0


def test_trusted_proxy_setting_matches_fixed_gateway(tmp_path):
    env_file = tmp_path / ".env"
    env_file.write_text("FJU_TRUSTED_PROXY_IPS=172.24.0.1/32\n", encoding="utf-8")
    command = f"source {shlex.quote(str(HELPER))}; verify_trusted_proxy_setting {shlex.quote(str(env_file))}"
    result = subprocess.run(["bash", "-c", command], cwd=ROOT, capture_output=True, text=True, check=False)
    assert result.returncode == 0, result.stderr


def _run_deploy_until_non_disruptive_failure(tmp_path: Path, trusted_proxy_value: str | None):
    """Run the real deploy preflight with fake commands before any cutover."""
    deploy_root = tmp_path / "deploy-root"
    scripts_dir = deploy_root / "scripts"
    bin_dir = tmp_path / "bin"
    bundle_dir = tmp_path / "bundle"
    scripts_dir.mkdir(parents=True)
    bin_dir.mkdir()
    bundle_dir.mkdir()

    (deploy_root / "deploy.sh").write_text(DEPLOY.read_text(encoding="utf-8"), encoding="utf-8")
    (scripts_dir / "deployment_network.sh").write_text(
        HELPER.read_text(encoding="utf-8"), encoding="utf-8"
    )
    (deploy_root / "compose.yaml").write_text("services: {}\n", encoding="utf-8")
    (deploy_root / "compose.build.yaml").write_text("services: {}\n", encoding="utf-8")
    verifier = deploy_root / "scripts" / "verify_artifact_bundle.py"
    _write_executable(verifier, "#!/usr/bin/env bash\nexit 0\n")

    env_lines = [] if trusted_proxy_value is None else [
        f"FJU_TRUSTED_PROXY_IPS={trusted_proxy_value}\n"
    ]
    env_file = deploy_root / ".env"
    env_file.write_text("".join(env_lines), encoding="utf-8")
    env_file.chmod(0o600)

    log_file = tmp_path / "commands.log"
    fake_docker = """#!/usr/bin/env bash
printf 'docker %s\\n' "$*" >> "$FAKE_COMMAND_LOG"
if [ "$1" = network ] && [ "$2" = inspect ]; then
  printf 'bridge|172.24.0.0/24|172.24.0.1\\n'
  exit 0
fi
if [ "$1" = stop ] || [ "$1" = rename ] || [ "$1" = start ]; then
  exit 99
fi
exit 1
"""
    _write_executable(bin_dir / "docker", fake_docker)
    _write_executable(
        bin_dir / "git",
        """#!/usr/bin/env bash
printf 'git %s\\n' "$*" >> "$FAKE_COMMAND_LOG"
exit 1
""",
    )
    _write_executable(bin_dir / "curl", "#!/usr/bin/env bash\nexit 0\n")
    _write_executable(bin_dir / "python3", "#!/usr/bin/env bash\nexit 0\n")

    environment = os.environ.copy()
    environment.update(
        {
            "PATH": f"{bin_dir}{os.pathsep}{environment['PATH']}",
            "FAKE_COMMAND_LOG": str(log_file),
            "CRS_ARTIFACT_BUNDLE_DIR": str(bundle_dir),
            "CRS_SKIP_PUBLIC_HEALTH": "1",
        }
    )
    result = subprocess.run(
        ["bash", str(deploy_root / "deploy.sh")],
        cwd=deploy_root,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )
    log = log_file.read_text(encoding="utf-8") if log_file.exists() else ""
    return result, log


@pytest.mark.parametrize("trusted_proxy_value", ["172.23.0.1/32", None, "not-a-cidr"])
def test_deploy_rejects_wrong_missing_or_invalid_trusted_proxy_before_stop(
    tmp_path, trusted_proxy_value
):
    result, log = _run_deploy_until_non_disruptive_failure(tmp_path, trusted_proxy_value)
    assert result.returncode != 0
    assert "fixed production trusted proxy setting preflight failed" in result.stderr
    assert "docker stop" not in log
    assert "docker rename" not in log
    assert "docker start" not in log
    assert "git pull" not in log


def test_deploy_accepts_fixed_trusted_proxy_before_non_disruptive_failure(tmp_path):
    result, log = _run_deploy_until_non_disruptive_failure(tmp_path, "172.24.0.1/32")
    assert result.returncode != 0
    assert "fixed production trusted proxy setting preflight failed" not in result.stderr
    assert "git pull --ff-only origin main" in log
    assert "docker stop" not in log


def test_network_and_trusted_proxy_preflights_precede_first_stop():
    source = DEPLOY.read_text(encoding="utf-8")
    network_preflight = source.index("verify_fixed_network ||")
    proxy_preflight = source.index("verify_trusted_proxy_setting .env ||")
    stop_previous = source.index('  docker stop "$previous_container_id"')
    assert network_preflight < proxy_preflight < stop_previous


def test_deploy_preflight_runs_before_cutover_stop_and_keeps_rollback():
    source = DEPLOY.read_text(encoding="utf-8")
    preflight = source.index("verify_fixed_network ||")
    stop_previous = source.index('  docker stop "$previous_container_id"')
    assert preflight < stop_previous
    assert "previous_container_id" in source
    assert 'docker start "$previous_container_id"' in source
    assert "docker network create" not in source
    assert "docker network rm" not in source
    assert "docker compose down" not in source
