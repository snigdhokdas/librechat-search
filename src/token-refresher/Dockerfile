FROM alpine:3.19
RUN apk add --no-cache bash curl jq kubectl
COPY refresh-tokens.sh /scripts/refresh-tokens.sh
RUN chmod +x /scripts/refresh-tokens.sh
ENTRYPOINT ["/bin/bash"]
CMD ["/scripts/refresh-tokens.sh"]
