FROM bitnami/kubectl:latest
COPY refresh-tokens.sh /scripts/
RUN chmod +x /scripts/refresh-tokens.sh
ENTRYPOINT ["/bin/bash"]
CMD ["/scripts/refresh-tokens.sh"]
