.PHONY: dev test smoke

dev:
	SPEECH_BACKEND=fake SPEECH_AUTH_DISABLED=true SPEECH_DATA_DIR=./.dev-data \
	uvicorn --factory app.main:app_factory --host 0.0.0.0 --port 8000 --reload

test:
	pytest -v

smoke:
	./scripts/smoke.sh
