FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl sudo \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://get.docker.com | sh
