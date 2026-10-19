#!/bin/sh
# Скачивает модель шумоподавления RNNoise для очистки голоса.
mkdir -p assets
curl -fsSL -o assets/rnnoise.rnnn https://raw.githubusercontent.com/GregorR/rnnoise-models/master/beguiling-drafter-2018-08-30/bd.rnnn \
  && echo "модель скачана" || echo "не удалось скачать модель; будет использован запасной шумодав"
